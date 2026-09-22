from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import os
import secrets
import sqlite3

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
import httpx

app = FastAPI(title="Alteon API Gateway")

QUERY_SVC = os.getenv("QUERY_SVC_URL", "http://query-svc:8000")
QUERY_SVC_TIMEOUT_SECONDS = int(os.getenv("QUERY_SVC_TIMEOUT_SECONDS", "310"))
AUTH_DB_PATH = os.getenv("AUTH_DB_PATH", "/data/auth.db")
SESSION_COOKIE = "alteon_session"
SESSION_DAYS = 7
PBKDF2_ITERATIONS = 200_000
ALLOWED_ROLES = {"admin", "user"}
PREFERENCE_KEY_DASHBOARD_LAYOUT = "dashboard-layout"
MAX_PREFERENCE_BYTES = 20 * 1024
LAYOUT_WIDGET_IDS = {
    "transaction",
    "bandwidthApps",
    "serviceFlow",
    "rs",
    "clients",
    "urls",
    "methods",
    "codes",
    "traffic",
    "bandwidth",
    "timeline",
    "latency",
    "rps",
    "serviceErrors",
    "realServerBandwidth",
    "virtualServices",
    "geoCountries",
    "userAgents",
    "contentTypes",
    "forwardedClients",
    "httpVersions",
    "serverRtt",
    "eventSeverity",
    "egressPaths",
    "alteonObjects",
    "appOutcomes",
}
MAX_LAYOUT_ITEMS = len(LAYOUT_WIDGET_IDS)


def utc_now():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def db_connect():
    os.makedirs(os.path.dirname(AUTH_DB_PATH), exist_ok=True)
    conn = sqlite3.connect(AUTH_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_auth_db():
    with db_connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              username TEXT NOT NULL UNIQUE,
              password_hash TEXT NOT NULL,
              role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
              created_at TEXT NOT NULL,
              deleted_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
              session_token_hash TEXT PRIMARY KEY,
              user_id INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              last_seen_at TEXT NOT NULL,
              expires_at TEXT NOT NULL,
              revoked_at TEXT,
              FOREIGN KEY(user_id) REFERENCES users(id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_preferences (
              user_id INTEGER NOT NULL,
              key TEXT NOT NULL,
              value_json TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY(user_id, key),
              FOREIGN KEY(user_id) REFERENCES users(id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS audit_log (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              created_at TEXT NOT NULL,
              user_id INTEGER,
              username TEXT,
              role TEXT,
              action TEXT NOT NULL,
              method TEXT NOT NULL,
              path TEXT NOT NULL,
              status_code INTEGER,
              detail_json TEXT,
              ip_address TEXT,
              user_agent TEXT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id)")


@app.on_event("startup")
async def startup():
    init_auth_db()


def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password, stored_hash):
    try:
        method, iterations, salt_hex, digest_hex = stored_hash.split("$", 3)
        if method != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            bytes.fromhex(salt_hex),
            int(iterations),
        )
        return hmac.compare_digest(digest.hex(), digest_hex)
    except Exception:
        return False


def hash_session_token(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def public_user(row):
    return {
        "id": row["id"],
        "username": row["username"],
        "role": row["role"],
        "created_at": row["created_at"],
    }


def public_session(row):
    created = datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
    last_seen = datetime.fromisoformat(row["last_seen_at"].replace("Z", "+00:00"))
    now = utc_now()
    return {
        "username": row["username"],
        "role": row["role"],
        "created_at": row["created_at"],
        "last_seen_at": row["last_seen_at"],
        "login_seconds": max(0, int((now - created).total_seconds())),
        "idle_seconds": max(0, int((now - last_seen).total_seconds())),
        "online": row["revoked_at"] is None and datetime.fromisoformat(row["expires_at"].replace("Z", "+00:00")) > now,
    }


def client_ip(request):
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",", 1)[0].strip()[:128]
    if request.client:
        return request.client.host[:128]
    return None


def audit_detail(**kwargs):
    return {key: value for key, value in kwargs.items() if value is not None}


def write_audit_log(request, action, user=None, status_code=None, detail=None):
    try:
        user = user or {}
        with db_connect() as conn:
            conn.execute(
                """
                INSERT INTO audit_log (
                  created_at, user_id, username, role, action, method, path,
                  status_code, detail_json, ip_address, user_agent
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    iso(utc_now()),
                    user.get("id"),
                    user.get("username"),
                    user.get("role"),
                    action,
                    request.method,
                    str(request.url.path),
                    status_code,
                    json.dumps(detail or {}, separators=(",", ":")),
                    client_ip(request),
                    request.headers.get("user-agent", "")[:300],
                ),
            )
    except Exception:
        pass


def public_audit_log(row):
    detail = {}
    try:
        detail = json.loads(row["detail_json"] or "{}")
    except Exception:
        detail = {}
    return {
        "id": row["id"],
        "created_at": row["created_at"],
        "username": row["username"],
        "role": row["role"],
        "action": row["action"],
        "method": row["method"],
        "path": row["path"],
        "status_code": row["status_code"],
        "detail": detail,
        "ip_address": row["ip_address"],
        "user_agent": row["user_agent"],
    }


def get_current_user(request, touch=True):
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None

    token_hash = hash_session_token(token)
    now_text = iso(utc_now())
    with db_connect() as conn:
        row = conn.execute(
            """
            SELECT s.session_token_hash, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at,
                   u.id, u.username, u.role, u.created_at AS user_created_at
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.session_token_hash = ?
              AND s.revoked_at IS NULL
              AND s.expires_at > ?
              AND u.deleted_at IS NULL
            """,
            (token_hash, now_text),
        ).fetchone()
        if not row:
            return None
        if touch:
            conn.execute("UPDATE sessions SET last_seen_at = ? WHERE session_token_hash = ?", (now_text, token_hash))

    return {
        "id": row["id"],
        "username": row["username"],
        "role": row["role"],
        "created_at": row["user_created_at"],
        "session_created_at": row["created_at"],
        "last_seen_at": now_text if touch else row["last_seen_at"],
        "expires_at": row["expires_at"],
    }


def require_user(request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")
    return user


def require_admin(request):
    user = require_user(request)
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")
    return user


def validate_username(username):
    value = (username or "").strip()
    if not value or len(value) > 64 or not all(c.isalnum() or c in "._-" for c in value):
        raise HTTPException(status_code=400, detail="Invalid username")
    return value


def validate_password(password):
    if not isinstance(password, str) or len(password) < 4:
        raise HTTPException(status_code=400, detail="Password must be at least 4 characters")
    return password


def validate_role(role):
    if role not in ALLOWED_ROLES:
        raise HTTPException(status_code=400, detail="Invalid role")
    return role


def clamp_int(value, minimum, maximum, field_name):
    if not isinstance(value, int):
        raise HTTPException(status_code=400, detail=f"Invalid layout field {field_name}")
    return max(minimum, min(maximum, value))


def validate_dashboard_layout_payload(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("layout"), list):
        raise HTTPException(status_code=400, detail="Layout payload must contain a layout array")

    layout = payload["layout"]
    if len(layout) == 0 or len(layout) > MAX_LAYOUT_ITEMS:
        raise HTTPException(status_code=400, detail="Invalid layout item count")

    seen = set()
    sanitized = []
    for item in layout:
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail="Invalid layout item")
        widget_id = item.get("i")
        if widget_id not in LAYOUT_WIDGET_IDS or widget_id in seen:
            raise HTTPException(status_code=400, detail="Invalid layout widget")
        seen.add(widget_id)

        x = clamp_int(item.get("x"), 0, 11, "x")
        y = clamp_int(item.get("y"), 0, 200, "y")
        w = clamp_int(item.get("w"), 1, 12, "w")
        h = clamp_int(item.get("h"), 1, 20, "h")
        if x + w > 12:
            w = 12 - x

        sanitized.append({"i": widget_id, "x": x, "y": y, "w": w, "h": h})

    encoded = json.dumps({"layout": sanitized}, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > MAX_PREFERENCE_BYTES:
        raise HTTPException(status_code=400, detail="Layout payload is too large")
    return sanitized, encoded


def create_user_record(username, password, role):
    username = validate_username(username)
    password = validate_password(password)
    role = validate_role(role)
    with db_connect() as conn:
        try:
            cur = conn.execute(
                """
                INSERT INTO users (username, password_hash, role, created_at, deleted_at)
                VALUES (?, ?, ?, ?, NULL)
                """,
                (username, hash_password(password), role, iso(utc_now())),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="User already exists")
        return cur.lastrowid


@app.get("/health")
async def health():
    return {"status": "ok", "service": "gateway"}


@app.post("/api/auth/login")
async def login(request: Request, response: Response):
    payload = await request.json()
    username = validate_username(payload.get("username"))
    password = validate_password(payload.get("password"))

    with db_connect() as conn:
        user = conn.execute(
            "SELECT id, username, password_hash, role, created_at FROM users WHERE username = ? AND deleted_at IS NULL",
            (username,),
        ).fetchone()
        if not user or not verify_password(password, user["password_hash"]):
            write_audit_log(
                request,
                "login_failed",
                status_code=401,
                detail=audit_detail(username=username),
            )
            raise HTTPException(status_code=401, detail="Invalid username or password")

        token = secrets.token_urlsafe(32)
        now = utc_now()
        expires = now + timedelta(days=SESSION_DAYS)
        conn.execute(
            """
            INSERT INTO sessions (session_token_hash, user_id, created_at, last_seen_at, expires_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, NULL)
            """,
            (hash_session_token(token), user["id"], iso(now), iso(now), iso(expires)),
        )

    write_audit_log(request, "login_success", user=public_user(user), status_code=200)
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        max_age=SESSION_DAYS * 24 * 60 * 60,
        path="/",
    )
    return {"user": public_user(user)}


@app.post("/api/auth/logout")
async def logout(request: Request, response: Response):
    user = get_current_user(request, touch=False)
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        with db_connect() as conn:
            conn.execute(
                "UPDATE sessions SET revoked_at = ? WHERE session_token_hash = ? AND revoked_at IS NULL",
                (iso(utc_now()), hash_session_token(token)),
            )
    write_audit_log(request, "logout", user=user, status_code=200)
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"status": "ok"}


@app.get("/api/auth/me")
async def me(request: Request):
    user = get_current_user(request)
    return {"user": user}


@app.get("/api/user/preferences/dashboard-layout")
async def get_dashboard_layout_preference(request: Request):
    user = require_user(request)
    with db_connect() as conn:
        row = conn.execute(
            "SELECT value_json, updated_at FROM user_preferences WHERE user_id = ? AND key = ?",
            (user["id"], PREFERENCE_KEY_DASHBOARD_LAYOUT),
        ).fetchone()
    write_audit_log(request, "dashboard_layout_read", user=user, status_code=200)
    if not row:
        return {"layout": None, "updated_at": None}

    try:
        value = json.loads(row["value_json"])
        layout = value.get("layout")
    except Exception:
        layout = None
    return {"layout": layout, "updated_at": row["updated_at"]}


@app.put("/api/user/preferences/dashboard-layout")
async def put_dashboard_layout_preference(request: Request):
    user = require_user(request)
    body = await request.body()
    if len(body) > MAX_PREFERENCE_BYTES:
        raise HTTPException(status_code=400, detail="Layout payload is too large")
    try:
        payload = json.loads(body.decode("utf-8"))
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    layout, encoded = validate_dashboard_layout_payload(payload)
    updated_at = iso(utc_now())
    with db_connect() as conn:
        conn.execute(
            """
            INSERT INTO user_preferences (user_id, key, value_json, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, key) DO UPDATE SET
              value_json = excluded.value_json,
              updated_at = excluded.updated_at
            """,
            (user["id"], PREFERENCE_KEY_DASHBOARD_LAYOUT, encoded, updated_at),
        )
    write_audit_log(
        request,
        "dashboard_layout_update",
        user=user,
        status_code=200,
        detail=audit_detail(items=len(layout)),
    )
    return {"layout": layout, "updated_at": updated_at}


@app.get("/api/admin/users")
async def list_users(request: Request):
    admin = require_admin(request)
    with db_connect() as conn:
        rows = conn.execute(
            """
            SELECT u.id, u.username, u.role, u.created_at,
                   MAX(CASE WHEN s.revoked_at IS NULL AND s.expires_at > ? THEN 1 ELSE 0 END) AS online,
                   MAX(s.created_at) AS last_login_at,
                   MAX(s.last_seen_at) AS last_seen_at
            FROM users u
            LEFT JOIN sessions s ON s.user_id = u.id
            WHERE u.deleted_at IS NULL
            GROUP BY u.id, u.username, u.role, u.created_at
            ORDER BY u.username
            """,
            (iso(utc_now()),),
        ).fetchall()
    write_audit_log(request, "admin_users_view", user=admin, status_code=200)
    return {
        "users": [
            {
                "id": row["id"],
                "username": row["username"],
                "role": row["role"],
                "created_at": row["created_at"],
                "online": bool(row["online"]),
                "last_login_at": row["last_login_at"],
                "last_seen_at": row["last_seen_at"],
            }
            for row in rows
        ]
    }


@app.post("/api/admin/users")
async def create_user(request: Request):
    admin = require_admin(request)
    payload = await request.json()
    user_id = create_user_record(payload.get("username"), payload.get("password"), payload.get("role", "user"))
    with db_connect() as conn:
        row = conn.execute("SELECT id, username, role, created_at FROM users WHERE id = ?", (user_id,)).fetchone()
    write_audit_log(
        request,
        "admin_user_create",
        user=admin,
        status_code=200,
        detail=audit_detail(target_user_id=user_id, target_username=row["username"], target_role=row["role"]),
    )
    return {"user": public_user(row)}


@app.delete("/api/admin/users/{user_id}")
async def delete_user(user_id: int, request: Request):
    current = require_admin(request)
    if user_id == current["id"]:
        raise HTTPException(status_code=400, detail="Cannot delete current user")

    with db_connect() as conn:
        row = conn.execute("SELECT id, username, role FROM users WHERE id = ? AND deleted_at IS NULL", (user_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        now = iso(utc_now())
        conn.execute("UPDATE users SET deleted_at = ? WHERE id = ?", (now, user_id))
        conn.execute("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", (now, user_id))
    write_audit_log(
        request,
        "admin_user_delete",
        user=current,
        status_code=200,
        detail=audit_detail(target_user_id=user_id, target_username=row["username"], target_role=row["role"]),
    )
    return {"status": "ok"}


@app.get("/api/admin/sessions")
async def list_sessions(request: Request):
    admin = require_admin(request)
    with db_connect() as conn:
        rows = conn.execute(
            """
            SELECT u.username, u.role, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE u.deleted_at IS NULL
            ORDER BY s.last_seen_at DESC
            LIMIT 100
            """
        ).fetchall()
    write_audit_log(request, "admin_sessions_view", user=admin, status_code=200)
    return {"sessions": [public_session(row) for row in rows]}


@app.get("/api/admin/audit")
async def list_audit(
    request: Request,
    limit: int = 200,
    username: str = "",
    action: str = "",
    status: str = "",
    q: str = "",
):
    admin = require_admin(request)
    limit = max(1, min(int(limit or 200), 500))
    where = []
    params = []

    username = (username or "").strip()
    if username:
        where.append("username LIKE ?")
        params.append(f"%{username[:64]}%")

    action = (action or "").strip()
    if action:
        where.append("action = ?")
        params.append(action[:80])

    status = (status or "").strip().lower()
    if status:
        if status.endswith("xx") and len(status) == 3 and status[0].isdigit():
            start = int(status[0]) * 100
            where.append("status_code >= ? AND status_code < ?")
            params.extend([start, start + 100])
        else:
            try:
                where.append("status_code = ?")
                params.append(int(status))
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid status filter")

    q = (q or "").strip()
    if q:
        needle = f"%{q[:120]}%"
        where.append("(path LIKE ? OR method LIKE ? OR detail_json LIKE ? OR ip_address LIKE ?)")
        params.extend([needle, needle, needle, needle])

    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    with db_connect() as conn:
        rows = conn.execute(
            f"""
            SELECT id, created_at, user_id, username, role, action, method, path,
                   status_code, detail_json, ip_address, user_agent
            FROM audit_log
            {where_sql}
            ORDER BY id DESC
            LIMIT ?
            """,
            (*params, limit),
        ).fetchall()
    write_audit_log(
        request,
        "admin_audit_view",
        user=admin,
        status_code=200,
        detail=audit_detail(limit=limit, username=username, action=action, status=status, q=q),
    )
    return {"events": [public_audit_log(row) for row in rows]}


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def proxy_query(path: str, request: Request):
    user = None
    if path == "health":
        pass
    elif path.startswith("auth/"):
        raise HTTPException(status_code=404, detail="Not found")
    else:
        user = require_user(request)

    url = f"{QUERY_SVC}/api/{path}"

    async with httpx.AsyncClient(timeout=QUERY_SVC_TIMEOUT_SECONDS) as client:
        try:
            r = await client.request(
                request.method,
                url,
                params=request.query_params,
                content=await request.body(),
            )
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Upstream unreachable: {e}")

    try:
        content = r.json()
    except json.JSONDecodeError:
        content = {"detail": r.text}
    if user:
        write_audit_log(
            request,
            "api_request",
            user=user,
            status_code=r.status_code,
            detail=audit_detail(api_path=f"/api/{path}", query=str(request.query_params)[:500]),
        )
    return JSONResponse(status_code=r.status_code, content=content)
