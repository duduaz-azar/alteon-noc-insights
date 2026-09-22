import { useEffect, useMemo, useRef, useState } from 'react';

const HEBREW_RE = /[\u0590-\u05FF]/;
const INSIGHT_META_RE = /^(here is|based on|technical observation|analysis:|1-sentence technical observation)/i;
const CONVERSATION_ID_KEY = 'alteon_ai_conversation_id_v1';
const INSIGHTS_POLL_INTERVAL_MS = 60000;

const AI_SAFE_ERROR_MESSAGES = {
  AI_UPSTREAM_TIMEOUT: 'שירות ה-AI אינו זמין כרגע. נסה שוב בעוד זמן קצר.',
  AI_UPSTREAM_UNAVAILABLE: 'שירות ה-AI אינו זמין כרגע. נסה שוב בעוד זמן קצר.',
  AI_UPSTREAM_ERROR: 'שירות ה-AI אינו זמין כרגע. נסה שוב בעוד זמן קצר.',
  AI_INVALID_RESPONSE: 'שירות ה-AI החזיר תגובה לא תקינה. נסה שוב בעוד זמן קצר.',
  AI_INTERNAL_ERROR: 'לא ניתן להשלים כרגע את הבדיקה. התקלה נרשמה לבדיקה.',
};

const EXAMPLE_PROMPTS = [
  'מה דורש תשומת לב עכשיו?',
  'תן לי סיכום NOC חי לשעה האחרונה',
  'איזה שירות הכי איטי?',
  'מי הלקוחות המובילים?',
  'איזה Real Servers בעייתיים?',
  'האם יש עלייה ב־5xx?',
  'איפה להתחיל תחקור?',
];

const SEVERITY_LABELS = {
  critical: 'קריטי',
  warning: 'אזהרה',
  info: 'מידע',
};

const SEVERITY_CLASSES = {
  critical: 'border-red-500/70 bg-red-500/10 text-red-100',
  warning: 'border-amber-400/70 bg-amber-400/10 text-amber-50',
  info: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-50',
};

const severityBadgeClass = (severity, isDark) => {
  if (isDark) {
    if (severity === 'critical') return 'border-red-400 text-red-200 bg-red-500/10';
    if (severity === 'warning') return 'border-amber-300 text-amber-100 bg-amber-400/10';
    return 'border-emerald-400 text-emerald-200 bg-emerald-500/10';
  }

  if (severity === 'critical') return 'border-red-500 text-red-700 bg-red-50';
  if (severity === 'warning') return 'border-amber-500 text-amber-700 bg-amber-50';
  return 'border-emerald-600 text-emerald-700 bg-emerald-50';
};

const getTextDirection = (text) => (HEBREW_RE.test(text || '') ? 'rtl' : 'ltr');

const getOrCreateConversationId = () => {
  if (typeof window === 'undefined') return 'server-render';
  const existing = window.localStorage.getItem(CONVERSATION_ID_KEY);
  if (existing) return existing;
  const generated = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `conv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  window.localStorage.setItem(CONVERSATION_ID_KEY, generated);
  return generated;
};

const formatCompactNumber = (value) => {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0';
  const absNumber = Math.abs(number);
  if (absNumber >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}G`;
  if (absNumber >= 1_000_000) return `${(number / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (absNumber >= 1_000) return `${(number / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${Math.round(number)}`;
};

const formatElapsed = (valueMs) => {
  const ms = Number(valueMs);
  if (!Number.isFinite(ms)) return '';
  const roundedMs = Math.max(0, Math.round(ms));
  if (roundedMs < 1000) return `${roundedMs}ms`;
  if (roundedMs < 60000) {
    const seconds = roundedMs / 1000;
    const formatted = seconds < 10
      ? seconds.toFixed(1).replace(/\.0$/, '')
      : Math.round(seconds).toString();
    return `${formatted}s`;
  }
  const minutes = Math.floor(roundedMs / 60000);
  const seconds = Math.round((roundedMs % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
};

const buildInsightFallback = (stats, period) => {
  if (!stats) return 'אין עדיין תובנה אוטומטית להצגה.';
  let parsed = null;
  if (typeof stats === 'string') {
    try {
      parsed = JSON.parse(stats);
    } catch {
      parsed = null;
    }
  } else if (typeof stats === 'object') {
    parsed = stats;
  }

  if (parsed && typeof parsed === 'object') {
    const current = parsed.current && typeof parsed.current === 'object' ? parsed.current : parsed;
    const requests = current.requests_total ?? current.requests ?? 0;
    const avgLatency = current.avg_latency_ms ?? current.avg_latency ?? 0;
    const p95 = current.p95_latency_ms ?? current.p95_latency ?? 0;
    const rate5xx = current.error_5xx_pct ?? parsed.error_5xx_pct ?? current.responses_5xx_pct ?? 0;
    return `חלון ${period || parsed.period || '5m'}: ${formatCompactNumber(requests)} בקשות, latency ממוצע ${Number(avgLatency || 0).toFixed(1)} ms, p95 ${Number(p95 || 0).toFixed(1)} ms, שיעור 5xx ${Number(rate5xx || 0).toFixed(2)}%.`;
  }

  const text = String(stats || '');
  const reqMatch = text.match(/Requests:\s*([0-9]+)/i);
  const avgMatch = text.match(/Avg Latency:\s*([0-9.]+)ms/i);
  const bytesMatch = text.match(/Bytes In:\s*([0-9]+)/i);
  if (reqMatch || avgMatch || bytesMatch) {
    return [
      `חלון ${period || '5m'}:`,
      reqMatch ? `${formatCompactNumber(reqMatch[1])} בקשות` : null,
      avgMatch ? `latency ממוצע ${Number(avgMatch[1]).toFixed(1)} ms` : null,
      bytesMatch ? `Bytes In ${formatCompactNumber(bytesMatch[1])}` : null,
    ].filter(Boolean).join(', ');
  }
  return 'תובנה היסטורית נשמרה בפורמט קודם ואינה זמינה להצגה מלאה בעברית.';
};

const normalizeInsightContent = (item) => {
  if (item?.summary) return String(item.summary);
  const raw = String(item?.content || '').trim().replace(/\s+/g, ' ');
  const cleaned = raw
    .replace(/^Here is the analysis:\s*/i, '')
    .replace(/^Here is a 1-sentence technical observation(?: based on the provided network traffic summary)?:\s*/i, '')
    .replace(/^Technical Observation:\s*/i, '')
    .trim();
  if (cleaned && HEBREW_RE.test(cleaned) && !INSIGHT_META_RE.test(cleaned)) return cleaned;
  if (cleaned && !INSIGHT_META_RE.test(cleaned) && HEBREW_RE.test(cleaned)) return cleaned;
  return buildInsightFallback(item?.stats, item?.period);
};

const buildAssistantMeta = (data) => {
  const flags = [];
  if (data?.intent) flags.push(`intent: ${data.intent}`);
  if (data?.used_clickhouse) flags.push('ClickHouse');
  if (data?.used_mcp) flags.push('MCP');
  if (data?.used_llm) flags.push('LLM');
  if (data?.ai_commentary_pending) flags.push('AI מעמיק');
  if (data?.correlation_confidence) flags.push(`confidence: ${data.correlation_confidence}`);
  const elapsed = formatElapsed(data?.elapsed_ms);
  if (elapsed) flags.push(elapsed);
  const missing = Array.isArray(data?.missing_evidence) ? data.missing_evidence.filter(Boolean).slice(0, 2) : [];
  return { flags, missing };
};

const createMessageId = () => (
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

export default function AiAssistant({ theme }) {
  const [question, setQuestion] = useState('');
  const [chat, setChat] = useState([]);
  const [loading, setLoading] = useState(false);
  const [insights, setInsights] = useState([]);
  const [insightsLoading, setInsightsLoading] = useState(true);
  const [insightsError, setInsightsError] = useState('');
  const inputDir = getTextDirection(question);
  const conversationId = useMemo(() => getOrCreateConversationId(), []);
  const insightsRequestInFlightRef = useRef(false);
  const insightsSignatureRef = useRef('');

  useEffect(() => {
    let cancelled = false;

    const loadInsights = async ({ initial = false } = {}) => {
      if (insightsRequestInFlightRef.current) return;
      insightsRequestInFlightRef.current = true;

      if (initial && !cancelled) {
        setInsightsLoading(true);
        setInsightsError('');
      }
      try {
        const response = await fetch('/api/latest-insights');
        if (!response.ok) throw new Error(`Insights request failed: ${response.status}`);
        const data = await response.json();
        const nextInsights = Array.isArray(data) ? data : [];
        const nextSignature = JSON.stringify(nextInsights.map((item) => [
          item?.timestamp || '',
          item?.content || '',
          item?.period || '',
          typeof item?.stats === 'string' ? item.stats : JSON.stringify(item?.stats || null)
        ]));

        if (!cancelled) {
          setInsightsError('');
          if (nextSignature !== insightsSignatureRef.current) {
            insightsSignatureRef.current = nextSignature;
            setInsights(nextInsights);
          }
        }
      } catch {
        if (!cancelled) {
          setInsightsError('לא ניתן לטעון תובנות כרגע.');
          if (initial) setInsights([]);
        }
      } finally {
        insightsRequestInFlightRef.current = false;
        if (!cancelled && initial) setInsightsLoading(false);
      }
    };

    loadInsights({ initial: true });
    const intervalId = window.setInterval(() => loadInsights({ initial: false }), INSIGHTS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const askAi = async () => {
    const prompt = question.trim();
    if (!prompt || loading) return;

    const questionDir = getTextDirection(prompt);
    let shouldClearQuestion = false;
    setLoading(true);
    setChat((prev) => [...prev, { role: 'user', content: prompt, dir: questionDir }]);

    try {
      const res = await fetch('/api/ask-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, conversation_id: conversationId })
      });
      const data = await res.json().catch(() => ({}));
      const content = String(
        data?.answer
        || AI_SAFE_ERROR_MESSAGES[data?.error_code]
        || 'לא התקבלה תשובה תקינה ממנוע ה-AI.'
      ).trim();
      if (content) {
        const assistantId = createMessageId();
        setChat((prev) => [...prev, {
          id: assistantId,
          role: 'assistant',
          content,
          dir: getTextDirection(content),
          meta: buildAssistantMeta(data),
          immediate: true,
          commentary: data?.ai_commentary_pending && data?.commentary_id
            ? {
                id: data.commentary_id,
                status: data.ai_commentary_status || 'pending',
                pending: true,
                text: '',
                elapsed_ms: null,
              }
            : null,
        }]);
        if (data?.ai_commentary_pending && data?.commentary_id) {
          pollAiCommentary(assistantId, data.commentary_id);
        }
      }
      shouldClearQuestion = Boolean(res.ok && data?.answer && !data?.error_code);
    } catch {
      setChat((prev) => [...prev, {
        role: 'assistant',
        content: 'שירות ה-AI אינו זמין כרגע או שהתרחשה שגיאת רשת.',
        dir: 'rtl'
      }]);
    } finally {
      setLoading(false);
      if (shouldClearQuestion) setQuestion('');
    }
  };

  const pollAiCommentary = async (messageId, commentaryId) => {
    const maxAttempts = 60;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, attempt === 0 ? 1200 : 3000));
      try {
        const res = await fetch(`/api/ai-commentary/${encodeURIComponent(commentaryId)}`);
        const data = await res.json().catch(() => ({}));
        const status = data?.ai_commentary_status || (res.ok ? 'pending' : 'failed');
        if (data?.ai_commentary_available && data?.ai_commentary_text) {
          const text = String(data.ai_commentary_text).trim();
          setChat((prev) => prev.map((msg) => (
            msg.id === messageId
              ? {
                  ...msg,
                  commentary: {
                    id: commentaryId,
                    status: 'complete',
                    pending: false,
                    text,
                    elapsed_ms: data.ai_commentary_elapsed_ms,
                  },
                  meta: buildAssistantMeta({ ...data, ...msg.meta, elapsed_ms: msg.meta?.elapsed_ms }),
                }
              : msg
          )));
          return;
        }
        if (!data?.ai_commentary_pending || ['rejected', 'failed', 'expired', 'not_found'].includes(status)) {
          setChat((prev) => prev.map((msg) => (
            msg.id === messageId
              ? {
                  ...msg,
                  commentary: {
                    id: commentaryId,
                    status,
                    pending: false,
                    text: '',
                    elapsed_ms: data?.ai_commentary_elapsed_ms,
                  },
                }
              : msg
          )));
          return;
        }
      } catch {
        if (attempt >= 3) {
          setChat((prev) => prev.map((msg) => (
            msg.id === messageId
              ? {
                  ...msg,
                  commentary: {
                    id: commentaryId,
                    status: 'failed',
                    pending: false,
                    text: '',
                    elapsed_ms: null,
                  },
                }
              : msg
          )));
          return;
        }
      }
    }
    setChat((prev) => prev.map((msg) => (
      msg.id === messageId
        ? {
            ...msg,
            commentary: {
              id: commentaryId,
              status: 'timeout',
              pending: false,
              text: '',
              elapsed_ms: null,
            },
          }
        : msg
    )));
  };

  const isDark = theme === 'dark';

  return (
    <div className={`flex flex-col h-full border-l ${isDark ? 'border-emerald-900/30 bg-black' : 'border-emerald-200 bg-white'}`}>
      <div className={`p-6 border-b flex flex-col h-1/2 ${isDark ? 'border-emerald-900/30 bg-black' : 'border-emerald-100 bg-white'}`}>
        <div dir="rtl" className="flex items-center mb-4 gap-3">
          <div className="flex gap-1 flex-shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
          </div>
          <h3 className="ai-insights-title flex-1 text-sm text-emerald-500">תובנות חיות</h3>
          <div className="sr-only" aria-hidden="true"></div>
        </div>

        <div className="flex flex-col gap-4 flex-1 overflow-y-auto custom-scrollbar pr-2">
          {insightsLoading ? (
            <div className={`text-sm italic py-4 border border-dashed rounded-xl text-center ${isDark ? 'text-white/60 border-emerald-900/50' : 'text-black/60 border-emerald-200'}`}>
              טוען תובנות חיות...
            </div>
          ) : insightsError ? (
            <div className={`text-sm italic py-4 border border-dashed rounded-xl text-center ${isDark ? 'text-red-200 border-red-900/40' : 'text-red-700 border-red-200'}`}>
              {insightsError}
            </div>
          ) : insights.length > 0 ? insights.map((ins, i) => {
            const severity = ins.severity || 'info';
            const evidence = Array.isArray(ins.evidence) ? ins.evidence.slice(0, 3) : [];
            return (
            <div key={i} dir="rtl" className={`group relative p-4 rounded-xl border transition-all duration-300 ${isDark ? SEVERITY_CLASSES[severity] || SEVERITY_CLASSES.info : 'bg-white border-emerald-200 hover:border-emerald-500 text-black'}`}>
              <div className="flex items-center justify-between gap-3 mb-2">
                <span className={`text-[10px] px-2 py-0.5 rounded border font-bold ${severityBadgeClass(severity, isDark)}`}>
                  {SEVERITY_LABELS[severity] || SEVERITY_LABELS.info}
                </span>
                <span className="text-xs font-mono text-emerald-500">{new Date(ins.timestamp).toLocaleTimeString()}</span>
              </div>
              {ins.title ? <h4 className={`text-sm font-bold mb-1 text-right ${isDark ? 'text-white' : 'text-black'}`}>{ins.title}</h4> : null}
              <p className={`ai-insight-text text-sm leading-relaxed text-right ${isDark ? 'text-white' : 'text-black'}`}>{normalizeInsightContent(ins)}</p>
              {evidence.length > 0 ? (
                <ul className={`mt-2 text-xs leading-relaxed text-right ${isDark ? 'text-white/75' : 'text-black/70'}`}>
                  {evidence.map((item, idx) => <li key={idx}>• {item}</li>)}
                </ul>
              ) : null}
              {ins.next_action ? (
                <div className={`mt-2 pt-2 border-t text-xs text-right ${isDark ? 'border-white/10 text-emerald-100' : 'border-black/10 text-emerald-700'}`}>
                  לבדוק עכשיו: {ins.next_action}
                </div>
              ) : null}
            </div>
          )}) : (
            <div className={`text-sm italic py-4 border border-dashed rounded-xl text-center ${isDark ? 'text-white/50 border-emerald-900/50' : 'text-black/50 border-emerald-200'}`}>
              עדיין אין תובנות זמינות לניתוח האוטומטי.
            </div>
          )}
        </div>
      </div>

      <div className={`flex-1 overflow-y-auto p-6 flex flex-col gap-4 custom-scrollbar ${isDark ? 'bg-black' : 'bg-white'}`}>
        {chat.map((msg, i) => (
          <div key={i} className={`flex flex-col ${msg.dir === 'rtl' ? 'items-end' : 'items-start'}`}>
            <div
              dir={msg.dir || 'ltr'}
              className={`ai-chat-message ${msg.role === 'user' ? 'ai-chat-message-user' : 'ai-chat-message-assistant'} ${isDark ? 'is-dark' : 'is-light'} max-w-[92%] px-4 py-3 rounded-2xl shadow-md ${
                msg.dir === 'rtl'
                  ? 'rounded-tr-none text-right'
                  : msg.role === 'user'
                    ? 'rounded-tr-none text-left'
                    : 'rounded-tl-none text-left'
              } ${
                msg.role === 'user'
                  ? 'bg-sky-500/18 text-sky-50 border border-sky-300/30'
                  : isDark
                    ? 'bg-amber-400/16 text-amber-50 border border-amber-200/30'
                    : 'bg-white text-black border border-amber-300'
              }`}
            >
              {msg.role === 'assistant' && msg.immediate ? (
                <div className={`mb-2 flex items-center justify-end gap-2 text-[11px] font-black tracking-wide ${isDark ? 'text-emerald-200' : 'text-emerald-700'}`}>
                  <span>תשובה מיידית</span>
                  <span className={`h-2 w-2 rounded-full ${isDark ? 'bg-emerald-300 shadow-[0_0_12px_rgba(110,231,183,0.8)]' : 'bg-emerald-600'}`}></span>
                </div>
              ) : null}
              {msg.content}
              {msg.role === 'assistant' && msg.commentary?.pending ? (
                <div dir="rtl" className={`mt-3 rounded-xl border px-3 py-2 text-right text-xs ${isDark ? 'border-emerald-300/20 bg-emerald-400/10 text-emerald-100' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>
                  <div className="flex items-center justify-end gap-2">
                    <span>ניתוח AI מעמיק בהכנה...</span>
                    <span className="relative flex h-3 w-3">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60"></span>
                      <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500"></span>
                    </span>
                  </div>
                </div>
              ) : null}
              {msg.role === 'assistant' && msg.commentary?.text ? (
                <div dir="rtl" className={`mt-3 rounded-xl border px-3 py-2 text-right ${isDark ? 'border-cyan-300/25 bg-cyan-400/10 text-cyan-50' : 'border-cyan-200 bg-cyan-50 text-cyan-900'}`}>
                  <div className="mb-1 text-[11px] font-black tracking-wide text-cyan-400">ניתוח AI</div>
                  <div className="text-sm leading-relaxed whitespace-pre-wrap">{msg.commentary.text}</div>
                  {Number.isFinite(Number(msg.commentary.elapsed_ms)) ? (
                    <div className={`mt-2 text-[10px] ${isDark ? 'text-white/45' : 'text-black/45'}`}>
                      הושלם אחרי {formatElapsed(msg.commentary.elapsed_ms)}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {msg.role === 'assistant' && msg.meta?.flags?.length ? (
                <div className={`mt-3 pt-2 border-t text-[11px] leading-relaxed ${isDark ? 'border-white/10 text-white/55' : 'border-black/10 text-black/55'}`}>
                  {msg.meta.flags.join(' · ')}
                  {msg.meta.missing?.length ? (
                    <div className="mt-1">חסר: {msg.meta.missing.join(' | ')}</div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ))}
        {loading && (
          <div dir="rtl" className="flex items-center gap-2 text-xs text-emerald-500 font-bold tracking-wide">
            <span className="w-2 h-2 bg-emerald-500 rounded-full animate-bounce"></span>
            מעבד שאלה...
          </div>
        )}
        <div className="ai-sidebar-brand-footer" aria-hidden="true">
          <div className="ai-sidebar-radware-logo-wrap">
            <img
              src={isDark ? '/brand/radware-logo-white.png' : '/brand/radware-logo-dark.png'}
              alt=""
              className="ai-sidebar-radware-logo"
            />
            <span className="radware-logo-pulse-dot radware-logo-pulse-dot--red"></span>
            <span className="radware-logo-pulse-dot radware-logo-pulse-dot--yellow"></span>
            <span className="radware-logo-pulse-dot radware-logo-pulse-dot--green"></span>
          </div>
        </div>
      </div>

      <div className={`p-6 border-t ${isDark ? 'border-emerald-900/30 bg-black' : 'border-emerald-100 bg-white'}`}>
        <div className="relative">
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !loading && askAi()}
            placeholder={EXAMPLE_PROMPTS[Math.floor(Date.now() / 60000) % EXAMPLE_PROMPTS.length]}
            dir={inputDir}
            disabled={loading}
            style={{ textAlign: inputDir === 'rtl' ? 'right' : 'left' }}
            className="w-full bg-white border-2 border-emerald-500/30 focus:border-emerald-500 text-black rounded-xl py-3 px-4 pr-14 text-sm font-normal shadow-lg transition-all outline-none disabled:opacity-60"
          />
          <button
            onClick={askAi}
            disabled={loading}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-2 bg-emerald-500 text-white rounded-lg hover:bg-emerald-400 transition-colors shadow-md disabled:opacity-60"
            title="שלח"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
