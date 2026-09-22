import re
import importlib.util
from functools import lru_cache
from datetime import datetime
from ipaddress import ip_address
from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import httpx
import os
import json
import logging

app = FastAPI(title="Alteon Query Service")
logger = logging.getLogger("alteon.query-svc")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

CH_HOST = os.getenv("CLICKHOUSE_HOST", "clickhouse")
CH_PORT = os.getenv("CLICKHOUSE_PORT", "8123")
CH_DB   = os.getenv("CLICKHOUSE_DB",   "alteon")
CH_URL  = f"http://{CH_HOST}:{CH_PORT}/"
AI_MACHINE_URL = os.getenv("AI_BRIDGE_URL", "http://ai-bridge:5050").rstrip("/")
AI_BRIDGE_TIMEOUT_SECONDS = int(os.getenv("AI_BRIDGE_TIMEOUT_SECONDS", "310"))
HOST_RE = re.compile(r"^[A-Za-z0-9._:-]{1,255}$")
PARTIAL_IP_RE = re.compile(r"^[A-Fa-f0-9:._-]{1,128}$")
SAFE_TEXT_RE = re.compile(r"^[^\x00-\x1f\x7f]{1,512}$")
METHOD_RE = re.compile(r"^[A-Z]{1,16}$")
REAL_SERVER_RE = re.compile(r"^[A-Za-z0-9:._-]{1,255}$")
GEO_COUNTRY_RE = re.compile(r"^[A-Za-z]{2}$|^(PRIVATE|UNKNOWN)$")
LATENCY_RANGE_ALIASES = {
    "<100ms": "<100ms",
    "lt100": "<100ms",
    "100-500ms": "100-500ms",
    "100-500": "100-500ms",
    "500ms-1s": "500ms-1s",
    "500-1000": "500ms-1s",
    "1s-3s": "1s-3s",
    "1000-3000": "1s-3s",
    ">3s": ">3s",
    ">3000": ">3s",
}
LATENCY_RANGE_SQL = {
    "<100ms": "(end_to_end_ms > 0 AND end_to_end_ms < 100)",
    "100-500ms": "(end_to_end_ms >= 100 AND end_to_end_ms < 500)",
    "500ms-1s": "(end_to_end_ms >= 500 AND end_to_end_ms < 1000)",
    "1s-3s": "(end_to_end_ms >= 1000 AND end_to_end_ms < 3000)",
    ">3s": "(end_to_end_ms >= 3000)",
}
GEOIP_DB_CANDIDATES = [
    "/data/geoip/GeoLite2-Country.mmdb",
    "/usr/share/GeoIP/GeoLite2-Country.mmdb",
    "/usr/local/share/GeoIP/GeoLite2-Country.mmdb",
    "/var/lib/GeoIP/GeoLite2-Country.mmdb",
]

RAW_FIELD_SQL = {
    "device_ip": "extract(message, 'dvc=([\\S]+)')",
    "src_ip": "extract(message, 'rdwrAltSrc=([\\S]+)')",
    "real_server": "extract(message, 'rdwrAltServerAddress=([\\S]+)')",
    "request_method": "extract(message, 'requestMethod=([\\S]+)')",
    "response_code": "toUInt16OrZero(extract(message, 'rdwrAltResponseCode=([\\S]+)'))",
    "url_path": "extract(message, 'rdwrAltPath=([\\S]+)')",
    "client_ip": "extract(message, 'rdwrAltClientIp=([\\S]+)')",
    "xff": "extract(message, 'rdwrAltXff=([\\S]+)')",
    "http_host": "extract(message, 'dhost=([\\S]+)')",
    "user_agent": "extract(message, 'requestClientApplication=(.+?) rdwrAlt')",
    "end_to_end_ms": "intDiv(toUInt32OrZero(extract(message, 'rdwrAltEndToEndTime=([\\S]+)')), 1000)",
    "server_rtt_ms": "toUInt32OrZero(extract(message, 'rdwrAltServerRtt=([\\S]+)')) / 1000.0",
    "event_severity": "extract(message, 'rdwrAltEventSeverity=([^\\s]+)')",
    "group_id": "extract(message, 'rdwrAltGroupId=([^\\s]+)')",
    "server_id": "extract(message, 'rdwrAltServerId=([^\\s]+)')",
    "object_id": "extract(message, 'rdwrAltObjectId=([^\\s]+)')",
    "app_id": "extract(message, 'rdwrAltAppId=([^\\s]+)')",
    "snmp_sysname": "extract(message, 'rdwrAltSnmpSysname=([^\\s]+)')",
    "egress_dst_address": "extract(message, 'rdwrAltEgressDstAddress=([^\\s]+)')",
    "egress_dst_port": "toUInt16OrZero(extract(message, 'rdwrAltEgressDstPort=([^\\s]+)'))",
    "egress_src_address": "extract(message, 'rdwrAltEgressSrcAddress=([^\\s]+)')",
    "egress_src_port": "toUInt16OrZero(extract(message, 'rdwrAltEgressSrcPort=([^\\s]+)'))",
    "outcome": "extract(message, 'outcome=([^\\s]+)')",
    "app_protocol": "extract(message, 'app=([^\\s]+)')",
    "rt_raw": "extract(message, 'rt=([^\\s]+)')",
}



def bad_request(message: str):
    raise HTTPException(status_code=400, detail=message)


@app.exception_handler(RequestValidationError)
async def request_validation_exception_handler(_, __):
    return JSONResponse(status_code=400, content={"detail": "Invalid request parameters"})


def sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def normalize_iso_string(value: str) -> str:
    normalized = value.strip().replace("T", " ")
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    return normalized


def parse_iso_datetime(value: str, field_name: str) -> datetime:
    try:
        return datetime.fromisoformat(normalize_iso_string(value))
    except ValueError:
        bad_request(f"{field_name} must be a valid ISO datetime")


def sql_datetime_literal(value: str, field_name: str) -> str:
    parse_iso_datetime(value, field_name)
    return sql_quote(normalize_iso_string(value))


def validate_minutes(minutes: int | None) -> int:
    value = 1440 if minutes is None else minutes
    if value < 1 or value > 43200:
        bad_request("minutes must be between 1 and 43200")
    return value


def validate_limit(limit: int) -> int:
    if limit < 1 or limit > 100:
        bad_request("limit must be between 1 and 100")
    return limit


def validate_host(host: str | None) -> str | None:
    if host is None or host == "":
        return None
    if not HOST_RE.fullmatch(host):
        bad_request("host contains invalid characters")
    return host


def validate_dst_ip(dst_ip: str | None) -> str | None:
    if dst_ip is None or dst_ip == "":
        return None
    try:
        return str(ip_address(dst_ip))
    except ValueError:
        bad_request("dst_ip must be a valid IPv4 or IPv6 address")


def validate_partial_ip(client_ip: str | None) -> str | None:
    if client_ip is None or client_ip == "":
        return None
    value = client_ip.strip()
    if not PARTIAL_IP_RE.fullmatch(value):
        bad_request("client_ip contains invalid characters")
    return value


def validate_uri_filter(uri: str | None) -> str | None:
    if uri is None or uri == "":
        return None
    value = uri.strip()
    if not SAFE_TEXT_RE.fullmatch(value):
        bad_request("uri contains invalid characters")
    return value


def validate_response_code_filter(response_code: str | None) -> str | None:
    if response_code is None or response_code == "":
        return None
    tokens = [item.strip().lower() for item in response_code.split(",") if item.strip()]
    if not tokens:
        bad_request("response_code is invalid")
    normalized_tokens: list[str] = []
    for token in tokens:
        if token in {"2xx", "3xx", "4xx", "5xx"}:
            normalized_tokens.append(token)
            continue
        parts = [p for p in token.split("/") if p]
        if not parts:
            bad_request("response_code is invalid")
        normalized_parts = []
        for code in parts:
            if not code.isdigit():
                bad_request("response_code is invalid")
            code_int = int(code)
            if code_int < 100 or code_int > 599:
                bad_request("response_code must be between 100 and 599")
            normalized_parts.append(str(code_int))
        normalized_tokens.append("/".join(normalized_parts))
    return ",".join(normalized_tokens)


def response_code_condition_single(response_code: str, column: str = "response_code") -> str:
    if response_code in {"2xx", "3xx", "4xx", "5xx"}:
        start = int(response_code[0]) * 100
        return f"({column} >= {start} AND {column} < {start + 100})"
    codes = [str(int(code)) for code in response_code.split("/")]
    if len(codes) == 1:
        return f"{column} = {codes[0]}"
    return f"{column} IN ({', '.join(codes)})"


def response_code_condition(response_code: str, column: str = "response_code") -> str:
    tokens = [item.strip().lower() for item in response_code.split(",") if item.strip()]
    if len(tokens) == 1:
        return response_code_condition_single(tokens[0], column=column)
    joined = " OR ".join(response_code_condition_single(token, column=column) for token in tokens)
    return f"({joined})"


def parse_multi_values(raw: str | None, value_validator, label: str) -> list[str]:
    if raw is None or raw == "":
        return []
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    if not parts:
        return []
    validated = []
    for part in parts:
        safe = value_validator(part)
        if safe is None:
            bad_request(f"{label} contains invalid value")
        validated.append(safe)
    return list(dict.fromkeys(validated))


def validate_method_filter(method: str | None) -> str | None:
    if method is None or method == "":
        return None
    value = method.strip().upper()
    if not METHOD_RE.fullmatch(value):
        bad_request("method contains invalid characters")
    return value


def validate_real_server_filter(real_server: str | None) -> str | None:
    if real_server is None or real_server == "":
        return None
    value = real_server.strip()
    if not REAL_SERVER_RE.fullmatch(value):
        bad_request("real_server contains invalid characters")
    return value


def validate_user_agent_filter(user_agent: str | None) -> str | None:
    if user_agent is None or user_agent == "":
        return None
    value = user_agent.strip()
    if not SAFE_TEXT_RE.fullmatch(value):
        bad_request("user_agent contains invalid characters")
    return value


def validate_geo_country_filter(geo_country: str | None) -> str | None:
    if geo_country is None or geo_country == "":
        return None
    value = geo_country.strip().upper()
    if not GEO_COUNTRY_RE.fullmatch(value):
        bad_request("geo_country is invalid")
    return value


def validate_latency_filter(latency: str | None) -> str | None:
    if latency is None or latency == "":
        return None
    key = latency.strip().lower().replace(" ", "")
    normalized = LATENCY_RANGE_ALIASES.get(key)
    if not normalized:
        bad_request("latency is invalid")
    return normalized


def latency_condition_single(latency: str, column: str = "end_to_end_ms") -> str:
    condition = LATENCY_RANGE_SQL.get(latency)
    if not condition:
        bad_request("latency is invalid")
    return condition.replace("end_to_end_ms", column)


def latency_condition(latency: str, column: str = "end_to_end_ms") -> str:
    tokens = [item.strip() for item in latency.split(",") if item.strip()]
    if len(tokens) == 1:
        return latency_condition_single(tokens[0], column=column)
    joined = " OR ".join(latency_condition_single(token, column=column) for token in tokens)
    return f"({joined})"


def or_contains_condition(column: str, values: list[str], case_sensitive: bool = True) -> str:
    if len(values) == 1:
        return contains_condition(column, values[0], case_sensitive=case_sensitive)
    conditions = [contains_condition(column, value, case_sensitive=case_sensitive) for value in values]
    return "(" + " OR ".join(conditions) + ")"


def contains_condition(column: str, value: str, case_sensitive: bool = True) -> str:
    quoted = sql_quote(value)
    if case_sensitive:
        return f"position({column}, {quoted}) > 0"
    return f"positionCaseInsensitive({column}, {quoted}) > 0"


def resolve_window_seconds(minutes: int, frm: str | None, to: str | None) -> int:
    if frm is not None and to is not None:
        frm_dt = parse_iso_datetime(frm, "frm")
        to_dt = parse_iso_datetime(to, "to")
        return max(1, int((to_dt - frm_dt).total_seconds()))
    return minutes * 60


def format_top_list_rows(rows):
    return [row for row in rows if row]


def find_geoip_db_path() -> str | None:
    configured = (os.getenv("GEOIP_DB_PATH") or "").strip()
    if configured and os.path.isfile(configured):
        return configured
    for candidate in GEOIP_DB_CANDIDATES:
        if os.path.isfile(candidate):
            return candidate
    return None


@lru_cache(maxsize=1)
def get_geoip_context():
    db_path = find_geoip_db_path()
    geoip2_available = bool(importlib.util.find_spec("geoip2"))
    if not db_path or not geoip2_available:
        return {
            "enabled": False,
            "message": "Geo DB not configured",
            "reader": None,
            "db_path": db_path,
            "geoip2_available": geoip2_available,
        }
    try:
        import geoip2.database
        reader = geoip2.database.Reader(db_path)
        return {
            "enabled": True,
            "message": "GeoIP enabled",
            "reader": reader,
            "db_path": db_path,
            "geoip2_available": True,
        }
    except Exception:
        return {
            "enabled": False,
            "message": "Geo DB not configured",
            "reader": None,
            "db_path": db_path,
            "geoip2_available": True,
        }


def is_public_ip(value: str | None) -> bool:
    if not value:
        return False
    try:
        parsed = ip_address(value)
    except ValueError:
        return False
    return not any([
        parsed.is_private,
        parsed.is_reserved,
        parsed.is_loopback,
        parsed.is_link_local,
        parsed.is_multicast,
        parsed.is_unspecified,
    ])


def first_public_ip_from_xff(xff: str | None) -> str | None:
    if not xff:
        return None
    for token in xff.split(','):
        candidate = token.strip()
        if is_public_ip(candidate):
            return candidate
    return None


def choose_geo_ip(xff: str | None, client_ip: str | None, src_ip: str | None) -> tuple[str | None, bool]:
    public_from_xff = first_public_ip_from_xff(xff)
    if public_from_xff:
        return public_from_xff, False
    for candidate in [client_ip, src_ip]:
        if is_public_ip(candidate):
            return candidate, False
    for candidate in [client_ip, src_ip]:
        if candidate:
            try:
                ip_address(candidate)
                return candidate, True
            except ValueError:
                continue
    if xff:
        for token in xff.split(','):
            candidate = token.strip()
            if not candidate:
                continue
            try:
                ip_address(candidate)
                return candidate, True
            except ValueError:
                continue
    return None, False


def iso_country_to_flag(country_code: str) -> str:
    if not country_code or len(country_code) != 2 or not country_code.isalpha():
        return "🏳"
    return ''.join(chr(127397 + ord(char.upper())) for char in country_code)


def lookup_country(reader, xff: str | None, client_ip: str | None, src_ip: str | None) -> dict:
    chosen_ip, is_private_only = choose_geo_ip(xff, client_ip, src_ip)
    if not chosen_ip:
        return {"country_code": "UNKNOWN", "country_name": "Unknown", "flag": "🏳"}
    if is_private_only:
        return {"country_code": "PRIVATE", "country_name": "Private/Internal", "flag": "🏠"}
    try:
        result = reader.country(chosen_ip)
        country = result.country
        code = country.iso_code or "UNKNOWN"
        name = country.name or code
        return {"country_code": code, "country_name": name, "flag": iso_country_to_flag(code)}
    except Exception:
        return {"country_code": "UNKNOWN", "country_name": "Unknown", "flag": "🏳"}


def sync_ch_query(sql: str):
    with httpx.Client(timeout=30) as client:
        response = client.post(CH_URL, params={"database": CH_DB, "default_format": "JSONEachRow"}, content=sql)
        if response.status_code != 200:
            raise HTTPException(status_code=502, detail=response.text)
        return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def build_geo_country_condition(base_where: str, geo_countries: list[str]) -> str:
    if not geo_countries:
        return ""
    geo = get_geoip_context()
    if not geo.get("enabled"):
        return "0"
    sql = f"SELECT xff, client_ip, src_ip FROM {CH_DB}.parsed_events WHERE {base_where} GROUP BY xff, client_ip, src_ip"
    rows = sync_ch_query(sql)
    reader = geo["reader"]
    allowed_xff = set()
    allowed_client = set()
    allowed_src = set()
    geo_country_set = set(geo_countries)
    for row in rows:
        country = lookup_country(reader, row.get("xff"), row.get("client_ip"), row.get("src_ip"))
        if country["country_code"] not in geo_country_set:
            continue
        chosen_ip, is_private_only = choose_geo_ip(row.get("xff"), row.get("client_ip"), row.get("src_ip"))
        if row.get("xff") and first_public_ip_from_xff(row.get("xff")):
            allowed_xff.add(row["xff"])
        elif chosen_ip and row.get("client_ip") == chosen_ip:
            allowed_client.add(chosen_ip)
        elif chosen_ip and row.get("src_ip") == chosen_ip:
            allowed_src.add(chosen_ip)
        elif is_private_only:
            if row.get("client_ip"):
                allowed_client.add(row["client_ip"])
            elif row.get("src_ip"):
                allowed_src.add(row["src_ip"])
    conditions = []
    if allowed_xff:
        conditions.append(f"xff IN ({', '.join(sql_quote(item) for item in sorted(allowed_xff))})")
    if allowed_client:
        conditions.append(f"client_ip IN ({', '.join(sql_quote(item) for item in sorted(allowed_client))})")
    if allowed_src:
        conditions.append(f"src_ip IN ({', '.join(sql_quote(item) for item in sorted(allowed_src))})")
    if not conditions:
        return "0"
    return "(" + " OR ".join(conditions) + ")"


def build_geo_country_options(where: str, limit: int = 20):
    geo = get_geoip_context()
    if not geo.get("enabled"):
        return [], geo.get("message", "Geo DB not configured"), "disabled"
    rows = sync_ch_query(f"SELECT xff, client_ip, src_ip, toUInt64(count()) AS requests FROM {CH_DB}.parsed_events WHERE {where} GROUP BY xff, client_ip, src_ip")
    reader = geo["reader"]
    countries = {}
    for row in rows:
        country = lookup_country(reader, row.get("xff"), row.get("client_ip"), row.get("src_ip"))
        code = country["country_code"]
        current = countries.setdefault(
            code,
            {
                "value": code,
                "country_code": code,
                "country_name": country["country_name"],
                "flag": country["flag"],
                "label": f"{country['flag']} {country['country_name']}",
                "requests": 0,
            },
        )
        current["requests"] += int(row.get("requests", 0) or 0)
    items = sorted(countries.values(), key=lambda item: item["requests"], reverse=True)[:limit]
    return items, None, "enabled"

def raw_field_expr(name: str) -> str:
    expr = RAW_FIELD_SQL.get(name)
    if not expr:
        raise KeyError(f"Unknown raw field: {name}")
    return expr


def build_raw_geo_country_condition(base_where: str, geo_countries: list[str]) -> str:
    if not geo_countries:
        return ""
    geo = get_geoip_context()
    if not geo.get("enabled"):
        return "0"
    sql = f"SELECT xff, client_ip, src_ip FROM {CH_DB}.parsed_events WHERE {base_where} GROUP BY xff, client_ip, src_ip"
    rows = sync_ch_query(sql)
    reader = geo["reader"]
    allowed_xff = set()
    allowed_client = set()
    allowed_src = set()
    geo_country_set = set(geo_countries)
    for row in rows:
        country = lookup_country(reader, row.get("xff"), row.get("client_ip"), row.get("src_ip"))
        if country["country_code"] not in geo_country_set:
            continue
        chosen_ip, is_private_only = choose_geo_ip(row.get("xff"), row.get("client_ip"), row.get("src_ip"))
        if row.get("xff") and first_public_ip_from_xff(row.get("xff")):
            allowed_xff.add(row["xff"])
        elif chosen_ip and row.get("client_ip") == chosen_ip:
            allowed_client.add(chosen_ip)
        elif chosen_ip and row.get("src_ip") == chosen_ip:
            allowed_src.add(chosen_ip)
        elif is_private_only:
            if row.get("client_ip"):
                allowed_client.add(row["client_ip"])
            elif row.get("src_ip"):
                allowed_src.add(row["src_ip"])
    conditions = []
    if allowed_xff:
        conditions.append(f"{raw_field_expr('xff')} IN ({', '.join(sql_quote(item) for item in sorted(allowed_xff))})")
    if allowed_client:
        conditions.append(f"{raw_field_expr('client_ip')} IN ({', '.join(sql_quote(item) for item in sorted(allowed_client))})")
    if allowed_src:
        conditions.append(f"{raw_field_expr('src_ip')} IN ({', '.join(sql_quote(item) for item in sorted(allowed_src))})")
    if not conditions:
        return "0"
    return "(" + " OR ".join(conditions) + ")"


def raw_dashboard_filter_window(minutes, frm, to, host=None, dst_ip=None, client_ip=None, response_code=None, uri=None, method=None, real_server=None, latency=None, user_agent=None, geo_country=None):
    minutes = validate_minutes(minutes)
    hosts = parse_multi_values(host, validate_host, "host")
    dst_ips = parse_multi_values(dst_ip, validate_dst_ip, "dst_ip")
    client_ips = parse_multi_values(client_ip, validate_partial_ip, "client_ip")
    response_code = validate_response_code_filter(response_code)
    uris = parse_multi_values(uri, validate_uri_filter, "uri")
    methods = parse_multi_values(method, validate_method_filter, "method")
    real_servers = parse_multi_values(real_server, validate_real_server_filter, "real_server")
    latencies = parse_multi_values(latency, validate_latency_filter, "latency")
    user_agents = parse_multi_values(user_agent, validate_user_agent_filter, "user_agent")
    geo_countries = parse_multi_values(geo_country, validate_geo_country_filter, "geo_country")

    if (frm is None) != (to is None):
        bad_request("frm and to must be provided together")

    if frm is not None and to is not None:
        frm_dt = parse_iso_datetime(frm, "frm")
        to_dt = parse_iso_datetime(to, "to")
        if to_dt <= frm_dt:
            bad_request("to must be after frm")
        from_expr = f"toDateTime({sql_datetime_literal(frm, 'frm')}, 'Asia/Jerusalem')"
        to_expr = f"toDateTime({sql_datetime_literal(to, 'to')}, 'Asia/Jerusalem')"
        where = f"timestamp >= {from_expr} AND timestamp < {to_expr}"
    else:
        where = f"timestamp >= now() - INTERVAL {int(minutes)} MINUTE"

    if hosts:
        where += f" AND {raw_field_expr('http_host')} IN ({', '.join(sql_quote(item) for item in hosts)})"
    if dst_ips:
        where += f" AND {raw_field_expr('device_ip')} IN ({', '.join(sql_quote(item) for item in dst_ips)})"
    if client_ips:
        where += f" AND {or_contains_condition(raw_field_expr('client_ip'), client_ips)}"
    if response_code:
        where += f" AND {response_code_condition(response_code, column=raw_field_expr('response_code'))}"
    if uris:
        where += f" AND {or_contains_condition(raw_field_expr('url_path'), uris, case_sensitive=False)}"
    if methods:
        where += f" AND {raw_field_expr('request_method')} IN ({', '.join(sql_quote(item) for item in methods)})"
    if real_servers:
        where += f" AND {raw_field_expr('real_server')} IN ({', '.join(sql_quote(item) for item in real_servers)})"
    if latencies:
        where += f" AND {latency_condition(','.join(latencies), column=raw_field_expr('end_to_end_ms'))}"
    if user_agents:
        where += f" AND {or_contains_condition(raw_field_expr('user_agent'), user_agents, case_sensitive=False)}"
    if geo_countries:
        parsed_where, _, _, _, _, _ = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, None)
        where += f" AND {build_raw_geo_country_condition(parsed_where, geo_countries)}"

    return where


def dashboard_filter_window(minutes, frm, to, host=None, dst_ip=None, client_ip=None, response_code=None, uri=None, method=None, real_server=None, latency=None, user_agent=None, geo_country=None):
    minutes = validate_minutes(minutes)
    hosts = parse_multi_values(host, validate_host, "host")
    dst_ips = parse_multi_values(dst_ip, validate_dst_ip, "dst_ip")
    client_ips = parse_multi_values(client_ip, validate_partial_ip, "client_ip")
    response_code = validate_response_code_filter(response_code)
    uris = parse_multi_values(uri, validate_uri_filter, "uri")
    methods = parse_multi_values(method, validate_method_filter, "method")
    real_servers = parse_multi_values(real_server, validate_real_server_filter, "real_server")
    latencies = parse_multi_values(latency, validate_latency_filter, "latency")
    user_agents = parse_multi_values(user_agent, validate_user_agent_filter, "user_agent")
    geo_countries = parse_multi_values(geo_country, validate_geo_country_filter, "geo_country")

    if (frm is None) != (to is None):
        bad_request("frm and to must be provided together")

    if frm is not None and to is not None:
        frm_dt = parse_iso_datetime(frm, "frm")
        to_dt = parse_iso_datetime(to, "to")
        if to_dt <= frm_dt:
            bad_request("to must be after frm")
        from_expr = f"toDateTime({sql_datetime_literal(frm, 'frm')}, 'Asia/Jerusalem')"
        to_expr   = f"toDateTime({sql_datetime_literal(to, 'to')},  'Asia/Jerusalem')"
        where = f"timestamp >= {from_expr} AND timestamp < {to_expr}"
        mins = max(1, int((to_dt - frm_dt).total_seconds() / 60))
    else:
        m = minutes
        from_expr = f"now() - INTERVAL {int(m)} MINUTE"
        to_expr   = "now()"
        where     = f"timestamp >= {from_expr}"
        mins      = m

    if hosts:
        where += f" AND http_host IN ({', '.join(sql_quote(item) for item in hosts)})"
    if dst_ips:
        where += f" AND device_ip IN ({', '.join(sql_quote(item) for item in dst_ips)})"
    if client_ips:
        where += f" AND {or_contains_condition('client_ip', client_ips)}"
    if response_code: where += f" AND {response_code_condition(response_code)}"
    if uris:
        where += f" AND {or_contains_condition('url_path', uris, case_sensitive=False)}"
    if methods:
        where += f" AND request_method IN ({', '.join(sql_quote(item) for item in methods)})"
    if real_servers:
        where += f" AND real_server IN ({', '.join(sql_quote(item) for item in real_servers)})"
    if latencies:
        where += f" AND {latency_condition(','.join(latencies))}"
    if user_agents:
        where += f" AND {or_contains_condition('user_agent', user_agents, case_sensitive=False)}"
    if geo_countries:
        where += f" AND {build_geo_country_condition(where, geo_countries)}"

    if mins <= 2: bucket_expr, secs, step = "timestamp", 1, "INTERVAL 1 SECOND"
    elif mins <= 30: bucket_expr, secs, step = "toStartOfMinute(timestamp)", 60, "INTERVAL 1 MINUTE"
    elif mins <= 360: bucket_expr, secs, step = "toStartOfFiveMinute(timestamp)", 300, "INTERVAL 5 MINUTE"
    elif mins <= 10080: bucket_expr, secs, step = "toStartOfHour(timestamp)", 3600, "INTERVAL 1 HOUR"
    else: bucket_expr, secs, step = "toStartOfInterval(timestamp, INTERVAL 6 HOUR)", 21600, "INTERVAL 6 HOUR"

    fill_from = f"toStartOfInterval({from_expr}, {step})"
    fill_to   = f"toStartOfInterval({to_expr},   {step})"
    return where, bucket_expr, secs, step, fill_from, fill_to

async def ch_query(sql):
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(CH_URL, params={"database": CH_DB, "default_format": "JSONEachRow"}, content=sql)
        if r.status_code != 200: raise HTTPException(status_code=502, detail=r.text)
        return [json.loads(line) for line in r.text.splitlines() if line.strip()]

@app.get("/api/filters/hosts")
async def filter_hosts():
    return [row["http_host"] for row in await ch_query(f"SELECT DISTINCT http_host FROM {CH_DB}.parsed_events WHERE http_host != '' ORDER BY http_host")]

@app.get("/api/filters/dst_ips")
async def filter_dst_ips():
    return [row["device_ip"] for row in await ch_query(f"SELECT DISTINCT device_ip FROM {CH_DB}.parsed_events WHERE device_ip != '' ORDER BY device_ip")]

@app.get("/api/traffic")
async def traffic(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    where, b, secs, step, f_f, f_t = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    sql = f"SELECT concat(replaceRegexpOne(toString(t, 'UTC'), ' ', 'T'), 'Z') AS ts, round(coalesce(sum(bytes_in)*8/{secs}/1000000,0),2) AS inbound_mbps, round(coalesce(sum(bytes_out)*8/{secs}/1000000,0),2) AS outbound_mbps FROM (SELECT {b} AS t, bytes_in, bytes_out FROM {CH_DB}.parsed_events WHERE {where}) GROUP BY t ORDER BY t WITH FILL FROM {f_f} TO {f_t} STEP {step}"
    return await ch_query(sql)

@app.get("/api/transaction-time")
async def transaction_time(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    where, b, _, step, f_f, f_t = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    sql = f"SELECT concat(replaceRegexpOne(toString(t, 'UTC'), ' ', 'T'), 'Z') AS ts, round(avgOrNull(end_to_end_ms),1) AS end_to_end_ms, round(avgOrNull(client_to_alteon_ms),1) AS client_to_alteon_ms, round(avgOrNull(alteon_processing_ms),1) AS alteon_processing_ms, round(avgOrNull(alteon_to_server_ms),1) AS alteon_to_server_ms, round(avgOrNull(server_process_ms),1) AS server_process_ms, round(avgOrNull(response_transfer_ms),1) AS response_transfer_ms FROM (SELECT {b} AS t, end_to_end_ms, client_to_alteon_ms, alteon_processing_ms, alteon_to_server_ms, server_process_ms, response_transfer_ms FROM {CH_DB}.parsed_events WHERE {where} AND end_to_end_ms > 0) GROUP BY t ORDER BY t WITH FILL FROM {f_f} TO {f_t} STEP {step}"
    return await ch_query(sql)

@app.get("/api/status-codes-time")
async def status_codes_time(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    where, b, _, step, f_f, f_t = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    sql = f"SELECT concat(replaceRegexpOne(toString(t, 'UTC'), ' ', 'T'), 'Z') AS ts, sum(response_code >= 200 AND response_code < 300) AS s2xx, sum(response_code >= 300 AND response_code < 400) AS s3xx, sum(response_code >= 400 AND response_code < 500) AS s4xx, sum(response_code >= 500 AND response_code < 600) AS s5xx FROM (SELECT {b} AS t, response_code FROM {CH_DB}.parsed_events WHERE {where}) GROUP BY t ORDER BY t WITH FILL FROM {f_f} TO {f_t} STEP {step}"
    return await ch_query(sql)

@app.get("/api/latency")
async def get_latency(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    where, b, _, step, f_f, f_t = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    sql = f"SELECT concat(replaceRegexpOne(toString(t, 'UTC'), ' ', 'T'), 'Z') AS ts, round(avgOrNull(latency_ms), 1) AS avg_ms FROM (SELECT {b} AS t, latency_ms FROM {CH_DB}.parsed_events WHERE {where}) GROUP BY t ORDER BY t WITH FILL FROM {f_f} TO {f_t} STEP {step}"
    return await ch_query(sql)

@app.get("/api/latency-time")
async def latency_time(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    return await get_latency(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)

@app.get("/api/rps")
async def get_rps(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    where, b, secs, step, f_f, f_t = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    sql = f"SELECT concat(replaceRegexpOne(toString(t, 'UTC'), ' ', 'T'), 'Z') AS ts, round(count(*) / {secs}, 2) AS rps FROM (SELECT {b} AS t FROM {CH_DB}.parsed_events WHERE {where}) GROUP BY t ORDER BY t WITH FILL FROM {f_f} TO {f_t} STEP {step}"
    return await ch_query(sql)

@app.get("/api/rps-time")
async def rps_time(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    return await get_rps(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)

@app.get("/api/summary")
async def summary(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    validated_minutes = validate_minutes(minutes)
    where, _, _, _, _, _ = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)

    if frm is not None and to is not None:
        frm_dt = parse_iso_datetime(frm, "frm")
        to_dt = parse_iso_datetime(to, "to")
        window_seconds = max(1, int((to_dt - frm_dt).total_seconds()))
        effective_minutes = max(1, int(window_seconds / 60))
    else:
        window_seconds = validated_minutes * 60
        effective_minutes = validated_minutes

    sql = f"""
    SELECT
      {effective_minutes} AS minutes,
      round(coalesce(sum(bytes_in + bytes_out) * 8 / {window_seconds} / 1000000, 0), 2) AS throughput_mbps,
      toUInt64(count()) AS requests_total,
      round(coalesce((sum(response_code >= 400 AND response_code < 600) / nullIf(count(), 0)) * 100, 0), 2) AS errors_percent,
      round(coalesce(avgIf(end_to_end_ms, end_to_end_ms > 0), 0), 1) AS latency_ms,
      toUInt64(count()) AS rows,
      concat(replaceRegexpOne(toString(min(timestamp), 'UTC'), ' ', 'T'), 'Z') AS window_start,
      concat(replaceRegexpOne(toString(max(timestamp), 'UTC'), ' ', 'T'), 'Z') AS window_end
    FROM {CH_DB}.parsed_events
    WHERE {where}
    """
    rows = await ch_query(sql)
    if rows:
        row = rows[0]
        if row.get("rows", 0) == 0:
            row["throughput_mbps"] = 0
            row["requests_total"] = 0
            row["errors_percent"] = 0
            row["latency_ms"] = 0
            row["window_start"] = None
            row["window_end"] = None
        return row

    return {
        "minutes": effective_minutes,
        "throughput_mbps": 0,
        "requests_total": 0,
        "errors_percent": 0,
        "latency_ms": 0,
        "rows": 0,
        "window_start": None,
        "window_end": None,
    }

@app.get("/api/http-methods")
async def http_methods(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    where, _, _, _, _, _ = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    return await ch_query(f"SELECT request_method AS method, count(*) AS count FROM {CH_DB}.parsed_events WHERE {where} AND request_method != '' GROUP BY method ORDER BY count DESC")

@app.get("/api/categories")
async def categories(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    return await http_methods(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)

@app.get("/api/response-codes")
async def response_codes(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    where, _, _, _, _, _ = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    return await ch_query(f"SELECT response_code AS code, count(*) AS count FROM {CH_DB}.parsed_events WHERE {where} AND response_code > 0 GROUP BY code ORDER BY count DESC")

@app.get("/api/top-clients")
async def top_clients(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, limit: int = 10, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    limit = validate_limit(limit)
    where, _, _, _, _, _ = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    return await ch_query(f"SELECT client_ip AS ip, count(*) AS count, round(avgOrNull(latency_ms), 1) AS avg_ms FROM {CH_DB}.parsed_events WHERE {where} AND client_ip != '' GROUP BY ip ORDER BY count DESC LIMIT {limit}")

@app.get("/api/top-bandwidth-consumers")
async def top_bandwidth_consumers(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, limit: int = 10, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    limit = validate_limit(limit)
    validated_minutes = validate_minutes(minutes)
    where, _, _, _, _, _ = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)

    if frm is not None and to is not None:
        frm_dt = parse_iso_datetime(frm, "frm")
        to_dt = parse_iso_datetime(to, "to")
        window_seconds = max(1, int((to_dt - frm_dt).total_seconds()))
    else:
        window_seconds = validated_minutes * 60

    return await ch_query(f"SELECT client_ip AS ip, toUInt64(sum(bytes_in + bytes_out)) AS total_bytes, toUInt64(count()) AS requests, round(coalesce(sum(bytes_in + bytes_out) * 8 / {window_seconds} / 1000000, 0), 2) AS avg_mbps FROM {CH_DB}.parsed_events WHERE {where} AND client_ip != '' GROUP BY ip ORDER BY total_bytes DESC LIMIT {limit}")

@app.get("/api/top-bandwidth-applications")
async def top_bandwidth_applications(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, limit: int = 10, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    limit = validate_limit(limit)
    validated_minutes = validate_minutes(minutes)
    where, _, _, _, _, _ = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)

    if frm is not None and to is not None:
        frm_dt = parse_iso_datetime(frm, "frm")
        to_dt = parse_iso_datetime(to, "to")
        window_seconds = max(1, int((to_dt - frm_dt).total_seconds()))
    else:
        window_seconds = validated_minutes * 60

    return await ch_query(f"SELECT http_host AS application, toUInt64(sum(bytes_in + bytes_out)) AS total_bytes, toUInt64(count()) AS requests, round(coalesce(sum(bytes_in + bytes_out) * 8 / {window_seconds} / 1000000, 0), 2) AS avg_mbps, round(coalesce(count() / nullIf({window_seconds}, 0), 0), 2) AS rps, round(coalesce(avgIf(end_to_end_ms, end_to_end_ms > 0), 0), 1) AS avg_latency_ms FROM {CH_DB}.parsed_events WHERE {where} AND http_host != '' GROUP BY application ORDER BY total_bytes DESC LIMIT {limit}")

@app.get("/api/service-flow")
async def service_flow(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None, limit: int = 5):
    limit = validate_limit(limit)
    validated_minutes = validate_minutes(minutes)
    where, _, _, _, _, _ = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)

    if frm is not None and to is not None:
        frm_dt = parse_iso_datetime(frm, "frm")
        to_dt = parse_iso_datetime(to, "to")
        window_seconds = max(1, int((to_dt - frm_dt).total_seconds()))
    else:
        window_seconds = validated_minutes * 60

    summary_rows = await ch_query(f"""
    SELECT
      toUInt64(count()) AS requests,
      toUInt64(uniqExact(client_ip)) AS distinct_clients,
      round(coalesce(count() / nullIf({window_seconds}, 0), 0), 2) AS rps,
      anyHeavy(http_host) AS selected_service,
      anyHeavy(dst_ip) AS selected_vip,
      anyHeavy(device_ip) AS selected_device,
      toUInt64(sum(response_code >= 200 AND response_code < 300)) AS s2xx,
      toUInt64(sum(response_code >= 300 AND response_code < 400)) AS s3xx,
      toUInt64(sum(response_code >= 400 AND response_code < 500)) AS s4xx,
      toUInt64(sum(response_code >= 500 AND response_code < 600)) AS s5xx,
      round(coalesce(avgOrNull(latency_ms), 0), 1) AS avg_latency_ms,
      round(coalesce(quantileOrNull(0.95)(latency_ms), 0), 1) AS p95_latency_ms,
      round(coalesce(avgOrNull(end_to_end_ms), 0), 1) AS avg_end_to_end_ms,
      round(coalesce(quantileOrNull(0.95)(end_to_end_ms), 0), 1) AS p95_end_to_end_ms,
      round(coalesce(avgOrNull(client_to_alteon_ms), 0), 1) AS client_to_alteon_ms,
      round(coalesce(avgOrNull(alteon_processing_ms), 0), 1) AS alteon_processing_ms,
      round(coalesce(avgOrNull(alteon_to_server_ms), 0), 1) AS alteon_to_server_ms,
      round(coalesce(avgOrNull(server_process_ms), 0), 1) AS server_process_ms,
      round(coalesce(avgOrNull(response_transfer_ms), 0), 1) AS response_transfer_ms
    FROM {CH_DB}.parsed_events
    WHERE {where}
    """)

    if not summary_rows:
        return {
            "meta": {
                "minutes": validated_minutes,
                "window_seconds": window_seconds,
                "where_applied": True,
                "real_server_mapping_available": False,
                "latency_segments_available": False,
            },
            "clients": {"distinct_clients": 0, "requests": 0, "rps": 0, "top_clients": []},
            "service": {"http_host": None, "vip": None, "requests": 0, "status": {"s2xx": 0, "s3xx": 0, "s4xx": 0, "s5xx": 0}},
            "alteon_cluster": {"mode": "visual_cluster", "active_device_ip": None, "standby_device_ip": None, "device_candidates": []},
            "real_servers": [],
            "latency": {"avg_latency_ms": 0, "p95_latency_ms": 0, "avg_end_to_end_ms": 0, "p95_end_to_end_ms": 0, "segments": None},
        }

    summary = summary_rows[0]

    top_clients = await ch_query(f"""
    SELECT client_ip, toUInt64(count()) AS requests
    FROM {CH_DB}.parsed_events
    WHERE {where} AND client_ip != ''
    GROUP BY client_ip
    ORDER BY requests DESC
    LIMIT {limit}
    """)

    service_rows = await ch_query(f"""
    SELECT http_host, dst_ip, device_ip, toUInt64(count()) AS requests
    FROM {CH_DB}.parsed_events
    WHERE {where} AND http_host != ''
    GROUP BY http_host, dst_ip, device_ip
    ORDER BY requests DESC
    LIMIT 1
    """)

    device_rows = await ch_query(f"""
    SELECT device_ip, toUInt64(count()) AS requests
    FROM {CH_DB}.parsed_events
    WHERE {where} AND device_ip != ''
    GROUP BY device_ip
    ORDER BY requests DESC
    LIMIT 2
    """)

    rs_rows = await ch_query(f"""
    SELECT
      real_server,
      toUInt64(count()) AS requests,
      toUInt64(sum(bytes_in + bytes_out)) AS total_bytes,
      round(coalesce(sum(bytes_in + bytes_out) * 8 / nullIf({window_seconds}, 0) / 1000000, 0), 2) AS avg_mbps,
      round(coalesce(avgOrNull(latency_ms), 0), 1) AS avg_latency_ms,
      round(coalesce(quantileOrNull(0.95)(latency_ms), 0), 1) AS p95_latency_ms,
      round(coalesce((sum(response_code >= 500 AND response_code < 600) / nullIf(count(), 0)) * 100, 0), 2) AS error_5xx_pct
    FROM {CH_DB}.parsed_events
    WHERE {where} AND real_server != ''
    GROUP BY real_server
    ORDER BY requests DESC
    LIMIT {limit}
    """)

    def classify_status(row):
        req = int(row.get("requests", 0) or 0)
        if req <= 0:
            return "UNKNOWN"
        error_pct = float(row.get("error_5xx_pct", 0) or 0)
        p95 = float(row.get("p95_latency_ms", 0) or 0)
        avg = float(row.get("avg_latency_ms", 0) or 0)
        if error_pct >= 5:
            return "ERROR"
        if p95 >= 1000 or avg >= 700:
            return "SLOW"
        return "UP"

    real_servers = []
    for row in rs_rows:
        real_servers.append({
            "real_server": row.get("real_server"),
            "requests": int(row.get("requests", 0) or 0),
            "total_bytes": int(row.get("total_bytes", 0) or 0),
            "avg_mbps": float(row.get("avg_mbps", 0) or 0),
            "avg_latency_ms": float(row.get("avg_latency_ms", 0) or 0),
            "p95_latency_ms": float(row.get("p95_latency_ms", 0) or 0),
            "error_5xx_pct": float(row.get("error_5xx_pct", 0) or 0),
            "status": classify_status(row),
        })

    primary_service = service_rows[0] if service_rows else {}
    selected_service = primary_service.get("http_host") or summary.get("selected_service")
    selected_vip = primary_service.get("dst_ip") or summary.get("selected_vip")
    selected_device = primary_service.get("device_ip") or summary.get("selected_device")

    segments = {
        "end_to_end_ms": float(summary.get("avg_end_to_end_ms", 0) or 0),
        "client_to_alteon_ms": float(summary.get("client_to_alteon_ms", 0) or 0),
        "alteon_processing_ms": float(summary.get("alteon_processing_ms", 0) or 0),
        "alteon_to_server_ms": float(summary.get("alteon_to_server_ms", 0) or 0),
        "server_process_ms": float(summary.get("server_process_ms", 0) or 0),
        "response_transfer_ms": float(summary.get("response_transfer_ms", 0) or 0),
    }
    latency_segments_available = any(value > 0 for value in segments.values())

    return {
        "meta": {
            "minutes": validated_minutes,
            "window_seconds": window_seconds,
            "where_applied": True,
            "real_server_mapping_available": len(real_servers) > 0,
            "latency_segments_available": latency_segments_available,
        },
        "clients": {
            "distinct_clients": int(summary.get("distinct_clients", 0) or 0),
            "requests": int(summary.get("requests", 0) or 0),
            "rps": float(summary.get("rps", 0) or 0),
            "top_clients": [{"client_ip": row.get("client_ip"), "requests": int(row.get("requests", 0) or 0)} for row in top_clients],
        },
        "service": {
            "http_host": selected_service,
            "vip": selected_vip,
            "requests": int(summary.get("requests", 0) or 0),
            "status": {
                "s2xx": int(summary.get("s2xx", 0) or 0),
                "s3xx": int(summary.get("s3xx", 0) or 0),
                "s4xx": int(summary.get("s4xx", 0) or 0),
                "s5xx": int(summary.get("s5xx", 0) or 0),
            },
        },
        "alteon_cluster": {
            "mode": "visual_cluster",
            "active_device_ip": selected_device,
            "standby_device_ip": None,
            "device_candidates": [{"device_ip": row.get("device_ip"), "requests": int(row.get("requests", 0) or 0)} for row in device_rows],
        },
        "real_servers": real_servers,
        "latency": {
            "avg_latency_ms": float(summary.get("avg_latency_ms", 0) or 0),
            "p95_latency_ms": float(summary.get("p95_latency_ms", 0) or 0),
            "avg_end_to_end_ms": float(summary.get("avg_end_to_end_ms", 0) or 0),
            "p95_end_to_end_ms": float(summary.get("p95_end_to_end_ms", 0) or 0),
            "segments": segments if latency_segments_available else None,
        },
    }

@app.get("/api/top-user-agents")
async def top_user_agents(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, limit: int = 10, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    limit = validate_limit(limit)
    where, _, _, _, _, _ = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    sql = f"SELECT user_agent, toUInt64(count()) AS requests, round(coalesce(avgIf(end_to_end_ms, end_to_end_ms > 0), 0), 1) AS avg_latency_ms, round(coalesce((sum(response_code >= 400 AND response_code < 600) / nullIf(count(), 0)) * 100, 0), 2) AS error_rate_pct FROM {CH_DB}.parsed_events WHERE {where} AND user_agent != '' GROUP BY user_agent ORDER BY requests DESC LIMIT {limit}"
    return await ch_query(sql)


@app.get("/api/content-types")
async def content_types(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    where, _, _, _, _, _ = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    sql = f"SELECT content_type, count(*) AS count FROM {CH_DB}.parsed_events WHERE {where} AND content_type != '' GROUP BY content_type ORDER BY count DESC"
    return await ch_query(sql)


@app.get("/api/top-virtual-services")
async def top_virtual_services(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, limit: int = 10, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    limit = validate_limit(limit)
    where, _, _, _, _, _ = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    sql = f"SELECT virtual_service, toUInt64(count()) AS requests, round(coalesce(avgIf(end_to_end_ms, end_to_end_ms > 0), 0), 1) AS avg_latency_ms, toUInt64(sum(bytes_in + bytes_out)) AS total_bytes FROM {CH_DB}.parsed_events WHERE {where} AND virtual_service != '' GROUP BY virtual_service ORDER BY requests DESC LIMIT {limit}"
    return await ch_query(sql)


@app.get("/api/top-real-servers-bandwidth")
async def top_real_servers_bandwidth(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, limit: int = 10, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    limit = validate_limit(limit)
    validated_minutes = validate_minutes(minutes)
    where, _, _, _, _, _ = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    window_seconds = resolve_window_seconds(validated_minutes, frm, to)
    sql = f"SELECT real_server, toUInt64(sum(bytes_in + bytes_out)) AS total_bytes, toUInt64(count()) AS requests, round(coalesce(sum(bytes_in + bytes_out) * 8 / {window_seconds} / 1000000, 0), 2) AS avg_mbps, round(coalesce(avgIf(end_to_end_ms, end_to_end_ms > 0), 0), 1) AS avg_latency_ms FROM {CH_DB}.parsed_events WHERE {where} AND real_server != '' GROUP BY real_server ORDER BY total_bytes DESC LIMIT {limit}"
    return await ch_query(sql)


@app.get("/api/top-service-errors")
async def top_service_errors(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, limit: int = 10, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    limit = validate_limit(limit)
    where, _, _, _, _, _ = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    sql = f"SELECT http_host AS service, toUInt64(count()) AS requests, toUInt64(sum(response_code >= 200 AND response_code < 300)) AS s2xx, toUInt64(sum(response_code >= 300 AND response_code < 400)) AS s3xx, toUInt64(sum(response_code >= 400 AND response_code < 500)) AS s4xx, toUInt64(sum(response_code >= 500 AND response_code < 600)) AS s5xx, round(coalesce((sum(response_code >= 400 AND response_code < 600) / nullIf(count(), 0)) * 100, 0), 2) AS error_rate FROM {CH_DB}.parsed_events WHERE {where} AND http_host != '' GROUP BY service ORDER BY error_rate DESC, requests DESC LIMIT {limit}"
    return await ch_query(sql)


@app.get("/api/geo-countries")
async def geo_countries(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, limit: int = 10, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    limit = validate_limit(limit)
    geo = get_geoip_context()
    if not geo.get("enabled"):
        return {"items": [], "geo_status": "disabled", "geo_message": geo.get("message", "Geo DB not configured")}
    where, _, _, _, _, _ = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    rows = await ch_query(f"SELECT xff, client_ip, src_ip, toUInt64(count()) AS requests, toUInt64(sum(bytes_in + bytes_out)) AS total_bytes, toUInt64(uniqExact(client_ip)) AS unique_clients FROM {CH_DB}.parsed_events WHERE {where} GROUP BY xff, client_ip, src_ip")
    totals = {}
    reader = geo["reader"]
    for row in rows:
        country = lookup_country(reader, row.get("xff"), row.get("client_ip"), row.get("src_ip"))
        code = country["country_code"]
        current = totals.setdefault(code, {
            "country_code": code,
            "country_name": country["country_name"],
            "flag": country["flag"],
            "requests": 0,
            "total_bytes": 0,
            "unique_clients": 0,
        })
        current["requests"] += int(row.get("requests", 0) or 0)
        current["total_bytes"] += int(row.get("total_bytes", 0) or 0)
        current["unique_clients"] += int(row.get("unique_clients", 0) or 0)
    items = sorted(totals.values(), key=lambda item: item["requests"], reverse=True)[:limit]
    for item in items:
        item["country_label"] = f"{item['flag']} {item['country_name']}"
    return {"items": items, "geo_status": "enabled", "geo_message": None}


@app.get("/api/top-forwarded-clients")
async def top_forwarded_clients(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, limit: int = 10, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    limit = validate_limit(limit)
    where, _, _, _, _, _ = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    sql = f"SELECT xff, toUInt64(count()) AS requests, toUInt64(uniqExact(client_ip)) AS unique_clients, round(coalesce(avgIf(end_to_end_ms, end_to_end_ms > 0), 0), 1) AS avg_latency_ms FROM {CH_DB}.parsed_events WHERE {where} AND xff != '' GROUP BY xff ORDER BY requests DESC LIMIT {limit}"
    return await ch_query(sql)


@app.get("/api/http-versions")
async def http_versions(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    where, _, _, _, _, _ = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    sql = f"SELECT http_version AS version, count(*) AS count FROM {CH_DB}.parsed_events WHERE {where} AND http_version != '' GROUP BY version ORDER BY count DESC"
    return await ch_query(sql)


@app.get("/api/server-rtt")
async def server_rtt(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, limit: int = 10, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    limit = validate_limit(limit)
    where = raw_dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    sql = f"""
    SELECT
      if(real_server != '', real_server, if(server_id != '', concat('ID:', server_id), 'unknown')) AS server_target,
      toUInt64(count()) AS requests,
      round(coalesce(avgOrNull(server_rtt_ms), 0), 1) AS avg_rtt_ms,
      round(coalesce(quantileOrNull(0.95)(server_rtt_ms), 0), 1) AS p95_rtt_ms,
      round(coalesce(max(server_rtt_ms), 0), 1) AS max_rtt_ms
    FROM (
      SELECT
        {raw_field_expr('real_server')} AS real_server,
        {raw_field_expr('server_id')} AS server_id,
        {raw_field_expr('server_rtt_ms')} AS server_rtt_ms
      FROM {CH_DB}.raw_events
      WHERE {where}
    )
    WHERE server_rtt_ms > 0
    GROUP BY server_target
    ORDER BY avg_rtt_ms DESC, requests DESC
    LIMIT {limit}
    """
    return await ch_query(sql)


@app.get("/api/event-severity")
async def event_severity(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    where = raw_dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    sql = f"""
    SELECT severity, toUInt64(count()) AS count
    FROM (
      SELECT {raw_field_expr('event_severity')} AS severity
      FROM {CH_DB}.raw_events
      WHERE {where}
    )
    WHERE severity != ''
    GROUP BY severity
    ORDER BY count DESC, severity ASC
    """
    return await ch_query(sql)


@app.get("/api/egress-paths")
async def egress_paths(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, limit: int = 10, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    limit = validate_limit(limit)
    where = raw_dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    sql = f"""
    SELECT
      concat(egress_src_address, ':', toString(egress_src_port), ' → ', egress_dst_address, ':', toString(egress_dst_port)) AS path,
      egress_src_address,
      egress_src_port,
      egress_dst_address,
      egress_dst_port,
      toUInt64(count()) AS requests,
      round(coalesce(avgOrNull(server_rtt_ms), 0), 1) AS avg_rtt_ms
    FROM (
      SELECT
        {raw_field_expr('egress_src_address')} AS egress_src_address,
        {raw_field_expr('egress_src_port')} AS egress_src_port,
        {raw_field_expr('egress_dst_address')} AS egress_dst_address,
        {raw_field_expr('egress_dst_port')} AS egress_dst_port,
        {raw_field_expr('server_rtt_ms')} AS server_rtt_ms
      FROM {CH_DB}.raw_events
      WHERE {where}
    )
    WHERE egress_src_address != '' AND egress_dst_address != ''
    GROUP BY egress_src_address, egress_src_port, egress_dst_address, egress_dst_port
    ORDER BY requests DESC, avg_rtt_ms DESC
    LIMIT {limit}
    """
    return await ch_query(sql)


@app.get("/api/alteon-objects")
async def alteon_objects(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, limit: int = 10, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    limit = validate_limit(limit)
    where = raw_dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    sql = f"""
    SELECT
      if(object_id != '', object_id, if(app_id != '', app_id, group_id)) AS object_name,
      object_id,
      app_id,
      group_id,
      toUInt64(count()) AS requests,
      toUInt64(uniqExact(server_id)) AS unique_servers
    FROM (
      SELECT
        {raw_field_expr('object_id')} AS object_id,
        {raw_field_expr('app_id')} AS app_id,
        {raw_field_expr('group_id')} AS group_id,
        {raw_field_expr('server_id')} AS server_id
      FROM {CH_DB}.raw_events
      WHERE {where}
    )
    WHERE object_id != '' OR app_id != '' OR group_id != ''
    GROUP BY object_id, app_id, group_id
    ORDER BY requests DESC, object_name ASC
    LIMIT {limit}
    """
    return await ch_query(sql)


@app.get("/api/app-outcomes")
async def app_outcomes(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    where = raw_dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    sql = f"""
    SELECT
      if(app_protocol != '' AND outcome != '', concat(app_protocol, ' / ', outcome), if(app_protocol != '', app_protocol, outcome)) AS label,
      toUInt64(count()) AS count
    FROM (
      SELECT
        {raw_field_expr('app_protocol')} AS app_protocol,
        {raw_field_expr('outcome')} AS outcome
      FROM {CH_DB}.raw_events
      WHERE {where}
    )
    WHERE app_protocol != '' OR outcome != ''
    GROUP BY label
    ORDER BY count DESC, label ASC
    """
    return await ch_query(sql)


@app.get("/api/top-urls")
async def top_urls(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, limit: int = 10, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    limit = validate_limit(limit)
    where, _, _, _, _, _ = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    return await ch_query(f"SELECT url_path AS url, count(*) AS count, round(avgOrNull(latency_ms), 1) AS avg_ms FROM {CH_DB}.parsed_events WHERE {where} AND url_path != '' GROUP BY url ORDER BY count DESC LIMIT {limit}")

@app.get("/api/top-endpoints")
async def top_endpoints(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, limit: int = 10, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    return await top_urls(minutes, frm, to, limit, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)

@app.get("/api/top-vs")
async def top_vs(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, limit: int = 10, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    limit = validate_limit(limit)
    where, _, _, _, _, _ = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    return await ch_query(f"SELECT http_host AS vs, count(*) AS count, round(avgOrNull(latency_ms), 1) AS avg_ms FROM {CH_DB}.parsed_events WHERE {where} AND http_host != '' GROUP BY vs ORDER BY count DESC LIMIT {limit}")

@app.get("/api/top-rs")
async def top_rs(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, limit: int = 10, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None):
    limit = validate_limit(limit)
    where, _, _, _, _, _ = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    return await ch_query(f"SELECT real_server AS rs, count(*) AS count, round(avgOrNull(latency_ms), 1) AS avg_ms FROM {CH_DB}.parsed_events WHERE {where} AND real_server != '' GROUP BY rs ORDER BY count DESC LIMIT {limit}")

@app.get("/api/filter-options")
async def filter_options(minutes: int | None = 1440, frm: str | None = None, to: str | None = None, host: str | None = None, dst_ip: str | None = None, client_ip: str | None = None, response_code: str | None = None, uri: str | None = None, method: str | None = None, real_server: str | None = None, latency: str | None = None, user_agent: str | None = None, geo_country: str | None = None, q: str | None = None):
    where, _, _, _, _, _ = dashboard_filter_window(minutes, frm, to, host, dst_ip, client_ip, response_code, uri, method, real_server, latency, user_agent, geo_country)
    q_value = (q or "").strip()
    q_safe = validate_uri_filter(q_value) if q_value else None
    host_like = f" AND positionCaseInsensitive(http_host, {sql_quote(q_safe)}) > 0" if q_safe else ""
    alteon_like = f" AND positionCaseInsensitive(device_ip, {sql_quote(q_safe)}) > 0" if q_safe else ""
    client_like = f" AND positionCaseInsensitive(client_ip, {sql_quote(q_safe)}) > 0" if q_safe else ""
    uri_like = f" AND positionCaseInsensitive(url_path, {sql_quote(q_safe)}) > 0" if q_safe else ""
    method_like = f" AND positionCaseInsensitive(request_method, {sql_quote(q_safe)}) > 0" if q_safe else ""
    real_server_like = f" AND positionCaseInsensitive(real_server, {sql_quote(q_safe)}) > 0" if q_safe else ""
    user_agent_like = f" AND positionCaseInsensitive(user_agent, {sql_quote(q_safe)}) > 0" if q_safe else ""
    limit = 20
    services_rows = await ch_query(
        f"SELECT http_host AS value, count(*) AS count FROM {CH_DB}.parsed_events "
        f"WHERE {where} AND http_host != ''{host_like} GROUP BY value ORDER BY count DESC LIMIT {limit}"
    )
    alteon_rows = await ch_query(
        f"SELECT device_ip AS value, count(*) AS count FROM {CH_DB}.parsed_events "
        f"WHERE {where} AND device_ip != ''{alteon_like} GROUP BY value ORDER BY count DESC LIMIT {limit}"
    )
    client_rows = await ch_query(
        f"SELECT client_ip AS value, count(*) AS count FROM {CH_DB}.parsed_events "
        f"WHERE {where} AND client_ip != ''{client_like} GROUP BY value ORDER BY count DESC LIMIT {limit}"
    )
    uri_rows = await ch_query(
        f"SELECT url_path AS value, count(*) AS count FROM {CH_DB}.parsed_events "
        f"WHERE {where} AND url_path != ''{uri_like} GROUP BY value ORDER BY count DESC LIMIT {limit}"
    )
    code_rows = await ch_query(
        f"SELECT response_code AS value, count(*) AS count FROM {CH_DB}.parsed_events "
        f"WHERE {where} AND response_code > 0 GROUP BY value ORDER BY count DESC LIMIT {limit}"
    )
    method_rows = await ch_query(
        f"SELECT request_method AS value, count(*) AS count FROM {CH_DB}.parsed_events "
        f"WHERE {where} AND request_method != ''{method_like} GROUP BY value ORDER BY count DESC LIMIT {limit}"
    )
    real_server_rows = await ch_query(
        f"SELECT real_server AS value, count(*) AS count FROM {CH_DB}.parsed_events "
        f"WHERE {where} AND real_server != ''{real_server_like} GROUP BY value ORDER BY count DESC LIMIT {limit}"
    )
    user_agent_rows = await ch_query(
        f"SELECT user_agent AS value, count(*) AS count FROM {CH_DB}.parsed_events "
        f"WHERE {where} AND user_agent != ''{user_agent_like} GROUP BY value ORDER BY count DESC LIMIT {limit}"
    )
    geo_country_rows, geo_country_message, geo_country_status = build_geo_country_options(where, limit)
    latency_counts_rows = await ch_query(f"""
        SELECT
            toUInt64(sum(end_to_end_ms > 0 AND end_to_end_ms < 100)) AS lt100,
            toUInt64(sum(end_to_end_ms >= 100 AND end_to_end_ms < 500)) AS r100_500,
            toUInt64(sum(end_to_end_ms >= 500 AND end_to_end_ms < 1000)) AS r500_1000,
            toUInt64(sum(end_to_end_ms >= 1000 AND end_to_end_ms < 3000)) AS r1000_3000,
            toUInt64(sum(end_to_end_ms >= 3000)) AS gt3000
        FROM {CH_DB}.parsed_events
        WHERE {where}
    """)
    latency_counts = latency_counts_rows[0] if latency_counts_rows else {}
    return {
        "services": [{"value": row["value"], "count": row["count"]} for row in services_rows],
        "alteons": [{"value": row["value"], "count": row["count"]} for row in alteon_rows],
        "client_ips": [{"value": row["value"], "count": row["count"]} for row in client_rows],
        "uris": [{"value": row["value"], "count": row["count"]} for row in uri_rows],
        "response_codes": [{"value": str(row["value"]), "count": row["count"]} for row in code_rows],
        "response_code_groups": ["2xx", "3xx", "4xx", "5xx", "200", "301/302", "401/403", "404", "500", "502/503/504"],
        "methods": [{"value": row["value"], "count": row["count"]} for row in method_rows],
        "real_servers": [{"value": row["value"], "count": row["count"]} for row in real_server_rows],
        "user_agents": [{"value": row["value"], "count": row["count"]} for row in user_agent_rows],
        "geo_countries": geo_country_rows,
        "geo_status": geo_country_status,
        "geo_message": geo_country_message,
        "latency_ranges": [
            {"value": "<100ms", "count": int(latency_counts.get("lt100", 0) or 0)},
            {"value": "100-500ms", "count": int(latency_counts.get("r100_500", 0) or 0)},
            {"value": "500ms-1s", "count": int(latency_counts.get("r500_1000", 0) or 0)},
            {"value": "1s-3s", "count": int(latency_counts.get("r1000_3000", 0) or 0)},
            {"value": ">3s", "count": int(latency_counts.get("gt3000", 0) or 0)},
        ],
    }

@app.post("/api/ask-ai")
async def ask_ai(payload: dict):
    prompt = str(payload.get("prompt") or payload.get("question") or "").strip()
    conversation_id = str(payload.get("conversation_id") or "").strip()
    if not prompt:
        return {
            "answer": "נדרש להזין שאלה ל-AI.",
            "error_code": "AI_BAD_REQUEST",
            "retryable": False,
        }

    def safe_error_payload(error_code: str, answer: str, status_code: int, retryable: bool) -> JSONResponse:
        return JSONResponse(
            status_code=status_code,
            content={
                "answer": answer,
                "error_code": error_code,
                "retryable": retryable,
            },
        )

    def sanitize_log_text(value: str, limit: int = 512) -> str:
        text = " ".join(str(value or "").split())
        return text[:limit]

    timeout = httpx.Timeout(AI_BRIDGE_TIMEOUT_SECONDS, connect=10.0, read=AI_BRIDGE_TIMEOUT_SECONDS, write=30.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            bridge_payload = {"question": prompt}
            if conversation_id:
                bridge_payload["conversation_id"] = conversation_id
            response = await client.post(f"{AI_MACHINE_URL}/api/ask", json=bridge_payload)
            try:
                data = response.json()
            except ValueError:
                logger.exception(
                    "AI bridge returned invalid JSON status=%s prompt=%s body=%s",
                    response.status_code,
                    sanitize_log_text(prompt),
                    sanitize_log_text(response.text),
                )
                return safe_error_payload(
                    "AI_INVALID_RESPONSE",
                    "שירות ה-AI החזיר תגובה לא תקינה. נסה שוב בעוד זמן קצר.",
                    502,
                    True,
                )

            if response.status_code >= 400:
                logger.error(
                    "AI bridge returned error status=%s prompt=%s body=%s",
                    response.status_code,
                    sanitize_log_text(prompt),
                    sanitize_log_text(response.text),
                )
                bridge_answer = str(data.get("answer") or "").strip()
                error_code = str(data.get("error_code") or "").strip()
                if not bridge_answer:
                    bridge_answer = "שירות ה-AI אינו זמין כרגע. נסה שוב בעוד זמן קצר."
                if not error_code:
                    error_code = "AI_UPSTREAM_ERROR"
                return safe_error_payload(
                    error_code,
                    bridge_answer,
                    504 if response.status_code == 504 else 502,
                    response.status_code in {408, 425, 429, 500, 502, 503, 504},
                )

            if "error" in data:
                logger.error(
                    "AI bridge logical error prompt=%s body=%s",
                    sanitize_log_text(prompt),
                    sanitize_log_text(response.text),
                )
                bridge_answer = str(data.get("answer") or data.get("error") or "").strip()
                if not bridge_answer:
                    bridge_answer = "שירות ה-AI אינו זמין כרגע. נסה שוב בעוד זמן קצר."
                return safe_error_payload(
                    str(data.get("error_code") or "AI_UPSTREAM_ERROR"),
                    bridge_answer,
                    502,
                    True,
                )

            passthrough_keys = (
                "answer",
                "sql",
                "comparison_sql",
                "version",
                "intent",
                "comparison_intent",
                "investigation_intent",
                "correlation_intent",
                "correlation_confidence",
                "evidence_count",
                "missing_evidence",
                "used_clickhouse",
                "used_llm",
                "llm_failed",
                "narrative_mode",
                "commentary_id",
                "ai_commentary_status",
                "ai_commentary_available",
                "ai_commentary_pending",
                "ai_commentary_text",
                "ai_commentary_elapsed_ms",
                "llm_commentary_used",
                "llm_rejected",
                "context_used",
                "used_mcp",
                "mcp_available",
                "mcp_error",
                "mcp_tools_used",
                "elapsed_ms",
                "target_type",
                "target_value",
                "current_window",
                "comparison_window",
                "context_ttl_seconds",
                "conversation_key_mode",
                "error_code",
                "retryable",
            )
            result = {key: data.get(key) for key in passthrough_keys if key in data}
            result.setdefault("answer", "")
            result.setdefault("sql", "")
            return result
        except httpx.ConnectTimeout:
            logger.exception("AI bridge connect timeout prompt=%s", sanitize_log_text(prompt))
            return safe_error_payload(
                "AI_UPSTREAM_TIMEOUT",
                "שירות ה-AI אינו זמין כרגע. נסה שוב בעוד זמן קצר.",
                504,
                True,
            )
        except httpx.ReadTimeout:
            logger.exception("AI bridge read timeout prompt=%s", sanitize_log_text(prompt))
            return safe_error_payload(
                "AI_UPSTREAM_TIMEOUT",
                "שירות ה-AI אינו זמין כרגע. נסה שוב בעוד זמן קצר.",
                504,
                True,
            )
        except httpx.ConnectError:
            logger.exception("AI bridge connection failed prompt=%s", sanitize_log_text(prompt))
            return safe_error_payload(
                "AI_UPSTREAM_UNAVAILABLE",
                "שירות ה-AI אינו זמין כרגע. נסה שוב בעוד זמן קצר.",
                502,
                True,
            )
        except httpx.RequestError:
            logger.exception("AI bridge request failed prompt=%s", sanitize_log_text(prompt))
            return safe_error_payload(
                "AI_UPSTREAM_ERROR",
                "שירות ה-AI אינו זמין כרגע. נסה שוב בעוד זמן קצר.",
                502,
                True,
            )
        except Exception:
            logger.exception("Unexpected AI proxy failure prompt=%s", sanitize_log_text(prompt))
            return safe_error_payload(
                "AI_INTERNAL_ERROR",
                "לא ניתן להשלים כרגע את בדיקת השירות. התקלה נרשמה לבדיקה.",
                500,
                False,
            )


@app.get("/api/ai-commentary/{commentary_id}")
async def ai_commentary(commentary_id: str):
    safe_id = re.sub(r"[^A-Fa-f0-9]", "", str(commentary_id or ""))[:64]
    if not safe_id:
        return JSONResponse(
            status_code=400,
            content={
                "commentary_id": "",
                "ai_commentary_status": "not_found",
                "ai_commentary_available": False,
                "ai_commentary_pending": False,
                "used_llm": False,
                "llm_failed": True,
                "llm_rejected": False,
                "narrative_mode": "commentary_not_found",
            },
        )
    timeout = httpx.Timeout(15.0, connect=5.0, read=15.0, write=5.0, pool=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            response = await client.get(f"{AI_MACHINE_URL}/api/commentary/{safe_id}")
            data = response.json()
        except (httpx.RequestError, ValueError):
            logger.exception("AI commentary status request failed commentary_id=%s", safe_id)
            return JSONResponse(
                status_code=502,
                content={
                    "commentary_id": safe_id,
                    "ai_commentary_status": "failed",
                    "ai_commentary_available": False,
                    "ai_commentary_pending": False,
                    "used_llm": False,
                    "llm_failed": True,
                    "llm_rejected": False,
                    "narrative_mode": "ai_commentary_failed",
                },
            )
    allowed = (
        "commentary_id",
        "ai_commentary_status",
        "ai_commentary_available",
        "ai_commentary_pending",
        "ai_commentary_text",
        "ai_commentary_elapsed_ms",
        "used_llm",
        "llm_commentary_used",
        "llm_failed",
        "llm_rejected",
        "narrative_mode",
        "version",
    )
    return JSONResponse(status_code=response.status_code, content={key: data.get(key) for key in allowed if key in data})


@app.get("/api/latest-insights")
async def get_latest_insights():
    try:
        sql = (
            f"SELECT toString(timestamp) AS ts, "
            f"insight AS content, stats, period "
            f"FROM {CH_DB}.llm_insights "
            f"WHERE timestamp > now() - INTERVAL 12 HOUR "
            f"ORDER BY timestamp DESC LIMIT 80"
        )
        rows = await ch_query(sql)
        structured = []
        fallback = []
        for row in rows:
            stats_raw = row.get("stats")
            parsed = None
            if isinstance(stats_raw, str) and stats_raw.strip().startswith("{"):
                try:
                    parsed = json.loads(stats_raw)
                except ValueError:
                    parsed = None
            if isinstance(parsed, dict) and parsed.get("kind") == "noc_live_insight":
                structured.append({
                    "timestamp": row.get("ts", ""),
                    "content": row.get("content", ""),
                    "stats": stats_raw,
                    "period": row.get("period", ""),
                    "type": parsed.get("category", ""),
                    "severity": parsed.get("severity", "info"),
                    "title": parsed.get("title", ""),
                    "summary": parsed.get("summary", row.get("content", "")),
                    "evidence": parsed.get("evidence", []),
                    "entity": parsed.get("entity", ""),
                    "window": parsed.get("window", row.get("period", "")),
                    "next_action": parsed.get("next_action", ""),
                    "source": parsed.get("source", "ClickHouse"),
                    "signature": parsed.get("signature", ""),
                })
                continue
            content = str(row.get("content") or "")
            if any("\u0590" <= ch <= "\u05ff" for ch in content):
                fallback.append(row)
        if structured:
            seen = set()
            unique = []
            for item in structured:
                signature = item.get("signature") or f"{item.get('timestamp')}:{item.get('title')}"
                if signature in seen:
                    continue
                seen.add(signature)
                unique.append(item)
                if len(unique) >= 6:
                    break
            return unique
        return fallback[:5]
    except Exception:
        return []

@app.get("/api/health")
async def health():
    return {"status": "ok"}
