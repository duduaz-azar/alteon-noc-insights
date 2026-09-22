import hashlib
import json
import os
import time

import requests

VERSION = "v5.80"
CH_HOST = os.getenv("CLICKHOUSE_HOST", "clickhouse")
CH_PORT = os.getenv("CLICKHOUSE_PORT", "8123")
CH_URL = f"http://{CH_HOST}:{CH_PORT}"
ANALYSIS_PERIOD = "15m"
QUERY_TIMEOUT = 20
MAX_INSIGHTS_PER_RUN = 6


def ch_post(query: str, timeout: int = QUERY_TIMEOUT) -> str:
    response = requests.post(CH_URL, data=query, timeout=timeout)
    response.raise_for_status()
    return response.text.strip()


def fetch_json_rows(query: str):
    text = ch_post(query.rstrip() + "\nFORMAT JSONEachRow")
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def percentage(part, whole):
    whole_value = float(whole or 0)
    if whole_value <= 0:
        return 0.0
    return round((float(part or 0) / whole_value) * 100.0, 2)


def pct_change(current, previous):
    previous_value = float(previous or 0)
    if previous_value == 0:
        return None
    return round(((float(current or 0) - previous_value) / previous_value) * 100.0, 1)


def compact_number(value):
    number = float(value or 0)
    abs_number = abs(number)
    if abs_number >= 1_000_000_000:
        return f"{number / 1_000_000_000:.1f}".rstrip("0").rstrip(".") + "G"
    if abs_number >= 1_000_000:
        return f"{number / 1_000_000:.1f}".rstrip("0").rstrip(".") + "M"
    if abs_number >= 1_000:
        return f"{number / 1_000:.1f}".rstrip("0").rstrip(".") + "K"
    return str(int(round(number)))


def stable_signature(*parts):
    raw = "|".join(str(part) for part in parts)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def insight(category, severity, title, summary, evidence, entity, next_action, signature_parts):
    signature = stable_signature(VERSION, category, severity, entity, *signature_parts)
    return {
        "version": VERSION,
        "kind": "noc_live_insight",
        "period": ANALYSIS_PERIOD,
        "category": category,
        "severity": severity,
        "title": title,
        "summary": summary,
        "evidence": evidence,
        "entity": entity,
        "window": "15 הדקות האחרונות",
        "next_action": next_action,
        "source": "ClickHouse / alteon.parsed_events",
        "signature": signature,
    }


def load_recent_signatures():
    query = """
SELECT stats
FROM alteon.llm_insights
WHERE timestamp > now() - INTERVAL 12 HOUR
ORDER BY timestamp DESC
LIMIT 200
"""
    signatures = set()
    for row in fetch_json_rows(query):
        try:
            stats = json.loads(row.get("stats") or "{}")
        except Exception:
            continue
        signature = stats.get("signature")
        if isinstance(signature, str) and signature:
            signatures.add(signature)
    return signatures


def fetch_global_rows():
    return fetch_json_rows("""
SELECT
  window,
  count() AS requests_total,
  sum(response_code >= 200 AND response_code < 300) AS responses_2xx,
  sum(response_code >= 300 AND response_code < 400) AS responses_3xx,
  sum(response_code >= 400 AND response_code < 500) AS responses_4xx,
  sum(response_code >= 500 AND response_code < 600) AS responses_5xx,
  coalesce(avgIf(end_to_end_ms, end_to_end_ms > 0), 0) AS avg_latency_ms,
  coalesce(quantileIf(0.95)(end_to_end_ms, end_to_end_ms > 0), 0) AS p95_latency_ms,
  coalesce(max(end_to_end_ms), 0) AS max_latency_ms,
  coalesce(sum(bytes_in + bytes_out), 0) AS bytes_total
FROM
(
  SELECT 'current' AS window, * FROM alteon.parsed_events WHERE timestamp > now() - INTERVAL 15 MINUTE
  UNION ALL
  SELECT 'previous' AS window, * FROM alteon.parsed_events
  WHERE timestamp > now() - INTERVAL 30 MINUTE AND timestamp <= now() - INTERVAL 15 MINUTE
)
GROUP BY window
""")


def fetch_slowest_services():
    return fetch_json_rows("""
SELECT service, requests_total, avg_latency_ms, p95_latency_ms, max_latency_ms, responses_5xx
FROM
(
  SELECT
    coalesce(nullIf(http_host, ''), nullIf(virtual_service, ''), dst_ip) AS service,
    count() AS requests_total,
    coalesce(avgIf(end_to_end_ms, end_to_end_ms > 0), 0) AS avg_latency_ms,
    coalesce(quantileIf(0.95)(end_to_end_ms, end_to_end_ms > 0), 0) AS p95_latency_ms,
    coalesce(max(end_to_end_ms), 0) AS max_latency_ms,
    sum(response_code >= 500 AND response_code < 600) AS responses_5xx
  FROM alteon.parsed_events
  WHERE timestamp > now() - INTERVAL 15 MINUTE
  GROUP BY service
  HAVING service != '' AND requests_total >= 50
)
ORDER BY p95_latency_ms DESC, avg_latency_ms DESC
LIMIT 5
""")


def fetch_service_errors():
    return fetch_json_rows("""
SELECT service, requests_total, responses_5xx, responses_4xx, error_5xx_pct
FROM
(
  SELECT
    coalesce(nullIf(http_host, ''), nullIf(virtual_service, ''), dst_ip) AS service,
    count() AS requests_total,
    sum(response_code >= 500 AND response_code < 600) AS responses_5xx,
    sum(response_code >= 400 AND response_code < 500) AS responses_4xx,
    round(sum(response_code >= 500 AND response_code < 600) * 100.0 / count(), 2) AS error_5xx_pct
  FROM alteon.parsed_events
  WHERE timestamp > now() - INTERVAL 15 MINUTE
  GROUP BY service
  HAVING service != '' AND requests_total >= 50 AND responses_5xx > 0
)
ORDER BY responses_5xx DESC, error_5xx_pct DESC
LIMIT 5
""")


def fetch_real_servers():
    return fetch_json_rows("""
SELECT real_server, requests_total, responses_5xx, error_5xx_pct, avg_latency_ms, p95_latency_ms
FROM
(
  SELECT
    real_server,
    count() AS requests_total,
    sum(response_code >= 500 AND response_code < 600) AS responses_5xx,
    round(sum(response_code >= 500 AND response_code < 600) * 100.0 / count(), 2) AS error_5xx_pct,
    coalesce(avgIf(end_to_end_ms, end_to_end_ms > 0), 0) AS avg_latency_ms,
    coalesce(quantileIf(0.95)(end_to_end_ms, end_to_end_ms > 0), 0) AS p95_latency_ms
  FROM alteon.parsed_events
  WHERE timestamp > now() - INTERVAL 15 MINUTE AND real_server != ''
  GROUP BY real_server
  HAVING requests_total >= 50
)
ORDER BY responses_5xx DESC, p95_latency_ms DESC
LIMIT 5
""")


def fetch_top_clients():
    return fetch_json_rows("""
SELECT client, requests_total, responses_5xx, bytes_total, p95_latency_ms
FROM
(
  SELECT
    coalesce(nullIf(client_ip, ''), src_ip) AS client,
    count() AS requests_total,
    sum(response_code >= 500 AND response_code < 600) AS responses_5xx,
    sum(bytes_in + bytes_out) AS bytes_total,
    coalesce(quantileIf(0.95)(end_to_end_ms, end_to_end_ms > 0), 0) AS p95_latency_ms
  FROM alteon.parsed_events
  WHERE timestamp > now() - INTERVAL 15 MINUTE
  GROUP BY client
  HAVING client != '' AND requests_total >= 50
)
ORDER BY requests_total DESC
LIMIT 5
""")


def fetch_problem_uris():
    return fetch_json_rows("""
SELECT url_path, requests_total, responses_5xx, p95_latency_ms
FROM
(
  SELECT
    url_path,
    count() AS requests_total,
    sum(response_code >= 500 AND response_code < 600) AS responses_5xx,
    coalesce(quantileIf(0.95)(end_to_end_ms, end_to_end_ms > 0), 0) AS p95_latency_ms
  FROM alteon.parsed_events
  WHERE timestamp > now() - INTERVAL 15 MINUTE AND url_path != ''
  GROUP BY url_path
  HAVING requests_total >= 50
)
ORDER BY responses_5xx DESC, p95_latency_ms DESC
LIMIT 5
""")


def build_insights():
    global_rows = {row["window"]: row for row in fetch_global_rows()}
    current = global_rows.get("current", {})
    previous = global_rows.get("previous", {})
    total = int(current.get("requests_total") or 0)
    c5xx = int(current.get("responses_5xx") or 0)
    avg_latency = float(current.get("avg_latency_ms") or 0)
    p95_latency = float(current.get("p95_latency_ms") or 0)
    c5xx_pct = percentage(c5xx, total)
    latency_delta = pct_change(avg_latency, previous.get("avg_latency_ms"))
    error_delta = pct_change(c5xx, previous.get("responses_5xx"))
    insights = []

    if total <= 0:
        insights.append(insight(
            "traffic", "warning", "אין תעבורה מספקת בחלון החי",
            "לא נמצאו מספיק אירועים ב-15 הדקות האחרונות כדי לקבוע מצב NOC.",
            [f"בקשות={compact_number(total)}"],
            "global",
            "להרחיב חלון זמן או לבדוק זרימת לוגים מ-Vector ל-ClickHouse.",
            ["no-traffic", total],
        ))
        return insights

    if c5xx_pct >= 1.0 or (error_delta is not None and error_delta >= 30 and c5xx > 0):
        insights.append(insight(
            "error", "critical" if c5xx_pct >= 1.0 else "warning",
            "עלייה בשגיאות 5xx",
            f"נמדדו {compact_number(c5xx)} שגיאות 5xx מתוך {compact_number(total)} בקשות.",
            [f"שיעור 5xx={c5xx_pct:.2f}%", f"שינוי מול חלון קודם={error_delta if error_delta is not None else 'לא זמין'}%"],
            "global",
            "לבדוק שירותים ו-real servers שמובילים 5xx.",
            ["5xx", int(c5xx_pct * 10), int(c5xx / 25)],
        ))

    if p95_latency >= 1000 or avg_latency >= 700 or (latency_delta is not None and latency_delta >= 25 and avg_latency >= 400):
        insights.append(insight(
            "latency", "warning",
            "latency גבוה בתעבורה החיה",
            f"p95 עומד על {p95_latency:.1f} ms ו-latency ממוצע {avg_latency:.1f} ms.",
            [f"p95={p95_latency:.1f} ms", f"avg={avg_latency:.1f} ms", f"שינוי avg={latency_delta if latency_delta is not None else 'לא זמין'}%"],
            "global",
            "להתחיל מהשירות האיטי ביותר ולבדוק real servers/URI.",
            ["latency", int(p95_latency / 100), int(avg_latency / 50)],
        ))

    for row in fetch_service_errors()[:2]:
        insights.append(insight(
            "service", "critical" if float(row.get("error_5xx_pct") or 0) >= 1 else "warning",
            f"שירות מוביל שגיאות: {row.get('service')}",
            f"{compact_number(row.get('responses_5xx'))} שגיאות 5xx בשירות מתוך {compact_number(row.get('requests_total'))} בקשות.",
            [f"5xx={compact_number(row.get('responses_5xx'))}", f"שיעור 5xx={row.get('error_5xx_pct')}%", f"4xx={compact_number(row.get('responses_4xx'))}"],
            row.get("service") or "service",
            "לבדוק real servers, URI וגרסאות אפליקציה תחת השירות.",
            ["service-error", row.get("service"), int(float(row.get("error_5xx_pct") or 0) * 10)],
        ))

    for row in fetch_slowest_services()[:2]:
        if float(row.get("p95_latency_ms") or 0) < 700:
            continue
        insights.append(insight(
            "latency", "warning",
            f"שירות איטי: {row.get('service')}",
            f"p95 latency בשירות הוא {float(row.get('p95_latency_ms') or 0):.1f} ms.",
            [f"בקשות={compact_number(row.get('requests_total'))}", f"avg={float(row.get('avg_latency_ms') or 0):.1f} ms", f"5xx={compact_number(row.get('responses_5xx'))}"],
            row.get("service") or "service",
            "להצליב עם real servers ו-URI של השירות בחלון הנבדק.",
            ["slow-service", row.get("service"), int(float(row.get("p95_latency_ms") or 0) / 100)],
        ))

    for row in fetch_real_servers()[:2]:
        if int(row.get("responses_5xx") or 0) <= 0 and float(row.get("p95_latency_ms") or 0) < 1000:
            continue
        insights.append(insight(
            "real_server", "warning",
            f"Real Server דורש בדיקה: {row.get('real_server')}",
            f"נמדדו {compact_number(row.get('responses_5xx'))} שגיאות 5xx ו-p95 {float(row.get('p95_latency_ms') or 0):.1f} ms.",
            [f"בקשות={compact_number(row.get('requests_total'))}", f"שיעור 5xx={row.get('error_5xx_pct')}%"],
            row.get("real_server") or "real_server",
            "לבדוק בריאות אפליקטיבית ותשתיתית של ה-real server.",
            ["rs", row.get("real_server"), int(row.get("responses_5xx") or 0), int(float(row.get("p95_latency_ms") or 0) / 100)],
        ))

    clients = fetch_top_clients()
    if clients:
        row = clients[0]
        insights.append(insight(
            "client", "info",
            f"לקוח מוביל תעבורה: {row.get('client')}",
            f"הלקוח יצר {compact_number(row.get('requests_total'))} בקשות בחלון החי.",
            [f"5xx={compact_number(row.get('responses_5xx'))}", f"bytes={compact_number(row.get('bytes_total'))}", f"p95={float(row.get('p95_latency_ms') or 0):.1f} ms"],
            row.get("client") or "client",
            "אם יש תלונה או שגיאות, לסנן לפי הלקוח ולבדוק URI ושירותים.",
            ["client", row.get("client"), int(float(row.get("requests_total") or 0) / 1000)],
        ))

    uris = fetch_problem_uris()
    if uris and (int(uris[0].get("responses_5xx") or 0) > 0 or float(uris[0].get("p95_latency_ms") or 0) >= 1000):
        row = uris[0]
        insights.append(insight(
            "endpoint", "warning",
            "URI תורם לשגיאות או latency",
            f"{row.get('url_path')} מוביל לפי 5xx או p95.",
            [f"בקשות={compact_number(row.get('requests_total'))}", f"5xx={compact_number(row.get('responses_5xx'))}", f"p95={float(row.get('p95_latency_ms') or 0):.1f} ms"],
            row.get("url_path") or "uri",
            "לבדוק שינויי אפליקציה או תלות backend סביב ה-URI.",
            ["uri", row.get("url_path"), int(row.get("responses_5xx") or 0), int(float(row.get("p95_latency_ms") or 0) / 100)],
        ))

    if not insights:
        insights.append(insight(
            "summary", "info",
            "אין מוקד חריג משמעותי כרגע",
            f"בחלון החי נמדדו {compact_number(total)} בקשות, 5xx בשיעור {c5xx_pct:.2f}% ו-p95 {p95_latency:.1f} ms.",
            [f"בקשות={compact_number(total)}", f"5xx={compact_number(c5xx)}", f"p95={p95_latency:.1f} ms"],
            "global",
            "להמשיך ניטור; אם יש תלונה, למקד לפי שירות או לקוח.",
            ["healthy", int(total / 1000), int(c5xx_pct * 10), int(p95_latency / 100)],
        ))

    severity_rank = {"critical": 0, "warning": 1, "info": 2}
    return sorted(insights, key=lambda item: (severity_rank.get(item["severity"], 9), item["category"]))[:MAX_INSIGHTS_PER_RUN]


def sql_escape(value):
    return str(value).replace("\\", "\\\\").replace("'", "''")


def save_insight(item):
    stats_json = json.dumps(item, ensure_ascii=False, separators=(",", ":"))
    insert_query = (
        "INSERT INTO alteon.llm_insights (timestamp, period, stats, insight) "
        f"VALUES (now(), '{ANALYSIS_PERIOD}', '{sql_escape(stats_json)}', '{sql_escape(item['summary'])}')"
    )
    ch_post(insert_query, timeout=10)


def run_analysis():
    print("Action: Building deterministic live NOC insights from alteon.parsed_events...")
    recent_signatures = load_recent_signatures()
    candidates = build_insights()
    saved = 0
    for item in candidates:
        if item["signature"] in recent_signatures:
            print(f"Status: Skipping duplicate {item['category']} insight {item['signature']}.")
            continue
        print(f"Insight: [{item['severity']}] {item['title']} - {item['summary']}")
        save_insight(item)
        recent_signatures.add(item["signature"])
        saved += 1
    print(f"Done: stored {saved} new live NOC insights.")


if __name__ == "__main__":
    print(f"Analyzer Started - Target: alteon.parsed_events ({VERSION})")
    while True:
        try:
            run_analysis()
        except Exception as exc:
            print(f"Runtime Error: {exc}")
        print("Waiting 5 minutes...")
        time.sleep(300)
