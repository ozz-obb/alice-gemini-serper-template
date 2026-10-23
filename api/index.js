
const DEFAULT_MODEL = "gpt-5.5";
const MAX_HISTORY_MESSAGES = 4;
const MAX_HISTORY_MESSAGE_CHARS = 700;
const MAX_ALICE_TEXT = 1024;

const TOTAL_RESPONSE_BUDGET_MS = 6500;
const SERPER_TIMEOUT_MS = 600;
const OPENAI_TIMEOUT_MS = 4000;

const API_BASE_URL = "https://api.tokenn.pro/v1";
const API_TIMEOUT_MS = 4500;

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "Обычно используй 1–3 коротких предложения.",
  "Не используй Markdown, таблицы, списки с символами или длинные вступления.",
  "Если вопрос требует актуальных данных и переданы результаты поиска, опирайся на них.",
  "Не выдумывай отсутствующие факты. Если не знаешь ответа, честно скажи об этом."
].join(" ");

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) {
    return text || "Не удалось подготовить ответ.";
  }

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );

  if (sentenceEnd >= 300) {
    return candidate.slice(0, sentenceEnd + 1).trim();
  }

  const lastSpace = candidate.lastIndexOf(" ");
  return (
    lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate
  ).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(item =>
      item &&
      (item.role === "user" || item.role === "model") &&
      typeof item.text === "string"
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({
      role: item.role,
      text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS)
    }));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const effectiveTimeout = Math.max(100, timeoutMs);

  const timer = setTimeout(
    () => controller.abort(),
    effectiveTimeout
  );

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));

    return {
      response,
      data,
      elapsedMs: Date.now() - startedAt
    };
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error("REQUEST_TIMEOUT");
      timeoutError.cause = error;
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";

  const startedAt = Date.now();

  try {
    const { response, data, elapsedMs } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          q: query,
          gl: "ru",
          hl: "ru",
          num: 3
        })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    console.log("SERPER_RESULT", {
      status: response.status,
      elapsedMs
    });

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }

    const items = (
      Array.isArray(data.organic) ? data.organic : []
    )
      .slice(0, 3)
      .map((item, i) => {
        const title = String(item.title || "").slice(0, 180);
        const snippet = String(item.snippet || "").slice(0, 350);
        const link = String(item.link || "").slice(0, 240);
        return `${i + 1}. ${title}: ${snippet} ${link}`.trim();
      });

    const answerBox = data.answerBox?.answer ||
      data.answerBox?.snippet;

    if (answerBox) {
      items.unshift(
        `Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`
      );
    }

    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.warn("SERPER_ERROR", {
      message: error?.message || "unknown error",
      elapsedMs: Date.now() - startedAt
    });
    return "";
  }
}

async function askOpenAI(text, history, searchContext, timeoutMs) {
  const key = process.env.OPENAI_API_KEY;

  if (!key) throw new Error("MISSING_OPENAI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(
    process.env.OPENAI_MODEL || DEFAULT_MODEL
  ).trim();

  if (!/^[A-Za-z0-9._-]+$/.test(model)) {
    throw new Error("INVALID_MODEL_NAME");
  }

  const messages = [
    {
      role: "system",
      content: SYSTEM_PROMPT
    }
  ];

  for (const item of safeHistory(history)) {
    messages.push({
      role: item.role === "model" ? "assistant" : "user",
      content: item.text
    });
  }

  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;

  messages.push({
    role: "user",
    content: prompt
  });

  const startedAt = Date.now();
  const requestTimeout = Math.min(API_TIMEOUT_MS, timeoutMs);

  console.log("MODEL_REQUEST_STARTED", {
    model,
    timeoutMs: requestTimeout,
    hasSearchContext: Boolean(searchContext),
    historyMessages: messages.length - 2
  });

  let result;

  try {
    result = await fetchJson(
      `${API_BASE_URL}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.5,
          max_tokens: 160
        })
      },
      requestTimeout
    );
  } catch (error) {
    console.error("MODEL_REQUEST_ERROR", {
      message: error?.message || "unknown error",
      elapsedMs: Date.now() - startedAt,
      timeoutMs: requestTimeout
    });
    throw error;
  }

  const { response, data, elapsedMs } = result;

  console.log("MODEL_RESPONSE_RECEIVED", {
    status: response.status,
    elapsedMs
  });

  if (!response.ok) {
    console.error(
      "API provider request failed with HTTP",
      response.status
    );

    if (response.status === 401 || response.status === 403) {
      throw new Error("OPENAI_KEY_REJECTED");
    }

    if (response.status === 429) {
      throw new Error("OPENAI_QUOTA");
    }

    throw new Error("OPENAI_REQUEST_FAILED");
  }

  const answer = data?.choices?.[0]?.message?.content?.trim();

  if (!answer) {
    console.error("API provider returned an empty or unexpected response.");
    throw new Error("OPENAI_EMPTY_RESPONSE");
  }

  return answer;
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_OPENAI_KEY":
      return "Сервер пока не настроен. Проверьте переменную OPENAI_API_KEY в настройках Vercel.";

    case "OPENAI_KEY_REJECTED":
      return "Провайдер отклонил API-ключ. Проверьте ключ и доступ к сервису.";

    case "OPENAI_QUOTA":
      return "У API-провайдера достигнут лимит запросов или квоты. Проверьте баланс аккаунта.";

    case "TIME_BUDGET_EXHAUSTED":
    case "REQUEST_TIMEOUT":
    case "AbortError":
      return "Ответ не успел прийти вовремя. Попробуйте ещё раз чуть позже.";

    case "OPENAI_EMPTY_RESPONSE":
      return "API-провайдер не вернул текст ответа. Проверьте поддержку выбранной модели.";

    default:
      return "Не получилось получить ответ от API-провайдера. Попробуйте ещё раз чуть позже.";
  }
}

export default async function handler(req, res) {
  console.log("ALICE_WEBHOOK_HIT", {
    method: req.method,
    hasBody: Boolean(req.body)
  });

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-token-provider-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const startedAt = Date.now();
  const remainingMs = () =>
    TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);

  const body = req.body && typeof req.body === "object"
    ? req.body
    : {};

  const text = String(
    body?.request?.command ||
    body?.request?.original_utterance ||
    ""
  ).trim();

  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(
      aliceResponse(
        "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
        false,
        oldHistory
      )
    );
  }

  try {
    let searchContext = "";

    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      const searchBudget = Math.min(
        SERPER_TIMEOUT_MS,
        Math.max(0, remainingMs() - OPENAI_TIMEOUT_MS - 500)
      );

      if (searchBudget >= 150) {
        searchContext = await searchWeb(text, searchBudget);
      }
    }

    const modelBudget = Math.min(
      OPENAI_TIMEOUT_MS,
      remainingMs() - 500
    );

    const answer = await askOpenAI(
      text,
      oldHistory,
      searchContext,
      modelBudget
    );

    const history = [
      ...oldHistory,
      {
        role: "user",
        text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS)
      },
      {
        role: "model",
        text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS)
      }
    ].slice(-MAX_HISTORY_MESSAGES);

    console.log("ALICE_WEBHOOK_SUCCESS", {
      elapsedMs: Date.now() - startedAt
    });

    return res.status(200).json(
      aliceResponse(answer, false, history)
    );
  } catch (error) {
    const isAbort = error?.name === "AbortError" ||
      error?.message === "AbortError" ||
      /aborted|abort/i.test(error?.message || "");

    const safeError = isAbort
      ? new Error("REQUEST_TIMEOUT")
      : error;

    console.warn("ALICE_WEBHOOK_FAILURE", {
      message: safeError?.message || "unknown error",
      elapsedMs: Date.now() - startedAt,
      remainingMs: remainingMs()
    });

    return res.status(200).json(
      aliceResponse(errorForUser(safeError), false, oldHistory)
    );
  }
}

export {
  aliceResponse,
  fitAliceText,
  isSearchIntent,
  safeHistory
};
