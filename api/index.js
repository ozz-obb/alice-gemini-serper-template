
const MODEL = "gpt-6.1-sol";
const API_BASE_URL = "https://api.tokenn.pro/v1";
const REQUEST_TIMEOUT_MS = 4000;
const MAX_ALICE_TEXT = 1024;
const MAX_HISTORY_MESSAGES = 4;
const MAX_HISTORY_CHARS = 700;

const SYSTEM_PROMPT = [
  "Ты — GPT-6.1-Sol, голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай на вопрос пользователя прямо, полезно и естественно.",
  "Используй русский язык, если пользователь пишет по-русски.",
  "Обычно отвечай кратко, в 1–4 предложениях, чтобы ответ было удобно слушать.",
  "Не используй Markdown, таблицы и сложное форматирование.",
  "Если не знаешь ответа, честно скажи об этом.",
  "Не утверждай, что проверил актуальные данные, если у тебя нет доступа к ним."
].join(" ");

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!text) return "Модель вернула пустой ответ.";
  if (text.length <= MAX_ALICE_TEXT) return text;

  const part = text.slice(0, MAX_ALICE_TEXT - 1);
  const end = Math.max(
    part.lastIndexOf(". "),
    part.lastIndexOf("! "),
    part.lastIndexOf("? ")
  );

  if (end >= 300) return part.slice(0, end + 1).trim();

  return part.slice(0, Math.max(1, part.lastIndexOf(" "))).trim() + "…";
}

function aliceResponse(text, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: false
    },
    session_state: { history }
  };
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
      text: item.text.slice(0, MAX_HISTORY_CHARS)
    }));
}

async function askModel(text, history) {
  const key = process.env.OPENAI_API_KEY;

  if (!key) throw new Error("MISSING_API_KEY");

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map(item => ({
      role: item.role === "model" ? "assistant" : "user",
      content: item.text
    })),
    { role: "user", content: text }
  ];

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );
  const startedAt = Date.now();

  try {
    console.log("GPT_REQUEST_STARTED", {
      model: MODEL,
      historyMessages: history.length
    });

    const response = await fetch(
      `${API_BASE_URL}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          temperature: 0.5,
          max_tokens: 180
        }),
        signal: controller.signal
      }
    );

    const raw = await response.text();
    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      data = {};
    }

    console.log("GPT_RESPONSE_RECEIVED", {
      status: response.status,
      elapsedMs: Date.now() - startedAt
    });

    if (!response.ok) {
      console.error("GPT_API_HTTP_ERROR", response.status);

      if (response.status === 401 || response.status === 403) {
        throw new Error("API_KEY_REJECTED");
      }

      if (response.status === 429) {
        throw new Error("API_QUOTA");
      }

      throw new Error("API_REQUEST_FAILED");
    }

    const answer = data?.choices?.[0]?.message?.content?.trim();

    if (!answer) throw new Error("EMPTY_MODEL_RESPONSE");

    return answer;
  } catch (error) {
    if (controller.signal.aborted) {
      console.error("GPT_REQUEST_TIMEOUT", {
        elapsedMs: Date.now() - startedAt
      });
      throw new Error("REQUEST_TIMEOUT");
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function userError(error) {
  switch (error?.message) {
    case "MISSING_API_KEY":
      return "Сервер не настроен: проверьте API-ключ в Vercel.";

    case "API_KEY_REJECTED":
      return "API-провайдер отклонил ключ. Проверьте доступ к сервису.";

    case "API_QUOTA":
      return "API-провайдер сообщил об ограничении запросов или баланса.";

    case "REQUEST_TIMEOUT":
      return "Ответ от модели не пришёл вовремя. Попробуйте ещё раз.";

    case "EMPTY_MODEL_RESPONSE":
      return "Модель вернула пустой ответ. Попробуйте задать вопрос иначе.";

    default:
      return "Не удалось получить ответ от модели. Попробуйте ещё раз.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gpt-bridge",
      model: MODEL
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body && typeof req.body === "object"
    ? req.body
    : {};

  const text = String(
    body?.request?.command ||
    body?.request?.original_utterance ||
    ""
  ).trim();

  const history = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(
      aliceResponse(
        "Привет! Задай мне любой вопрос, и я постараюсь помочь.",
        history
      )
    );
  }

  const startedAt = Date.now();

  try {
    const answer = await askModel(text, history);

    const newHistory = [
      ...history,
      { role: "user", text: text.slice(0, MAX_HISTORY_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    console.log("ALICE_GPT_SUCCESS", {
      elapsedMs: Date.now() - startedAt
    });

    return res.status(200).json(aliceResponse(answer, newHistory));
  } catch (error) {
    console.error("ALICE_GPT_FAILURE", {
      message: error?.message || "unknown error",
      elapsedMs: Date.now() - startedAt
    });

    return res.status(200).json(
      aliceResponse(userError(error), history)
    );
  }
}
