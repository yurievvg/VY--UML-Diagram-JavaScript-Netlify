const zlib = require("node:zlib");

const PLANTUML_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

function getEnvValue(key) {
  return String(process.env[key] || "").trim();
}

function getYandexCredentials() {
  const apiKey = getEnvValue("YANDEX_API_KEY");
  const folderId = getEnvValue("YANDEX_FOLDER_ID");

  if (!apiKey || !folderId) {
    const missing = [];
    if (!apiKey) missing.push("YANDEX_API_KEY");
    if (!folderId) missing.push("YANDEX_FOLDER_ID");
    throw new Error(`Отсутствуют переменные окружения: ${missing.join(", ")}`);
  }

  return { apiKey, folderId };
}

function getExpectedAccessCode() {
  return getEnvValue("ACCESS_CODE");
}

function isAccessCodeValid(userCode) {
  const expectedCode = getExpectedAccessCode();
  if (!expectedCode) {
    return [false, "В переменных окружения не задан ACCESS_CODE."];
  }
  if (!userCode) {
    return [false, "Введите код доступа."];
  }
  if (userCode !== expectedCode) {
    return [false, "Неверный код доступа."];
  }
  return [true, ""];
}

async function callYandexGpt(messages, maxTokens = 1200) {
  const { apiKey, folderId } = getYandexCredentials();
  const response = await fetch("https://llm.api.cloud.yandex.net/foundationModels/v1/completion", {
    method: "POST",
    headers: {
      Authorization: `Api-Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      modelUri: `gpt://${folderId}/yandexgpt/latest`,
      completionOptions: {
        stream: false,
        temperature: 0.3,
        maxTokens,
      },
      messages,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ошибка запроса к YandexGPT: ${response.status} ${body}`);
  }

  const data = await response.json();
  const text = data?.result?.alternatives?.[0]?.message?.text;
  if (!text) {
    throw new Error("YandexGPT вернул пустой ответ.");
  }

  return text.trim();
}

function parseSmartSteps(rawText) {
  const lines = String(rawText || "").split(/\r?\n/);
  const steps = [];
  for (const line of lines) {
    let text = line.trim();
    text = text.replace(/^[-*•]\s*/u, "");
    text = text.replace(/^\d+[.)]\s*/u, "");
    text = text.replace(/^Шаг\s*\d+\s*:\s*/iu, "");
    if (text && !steps.includes(text)) {
      steps.push(text);
    }
  }
  return steps.slice(0, 10);
}

function extractProcessDescriptions(umlText, diagramType) {
  const lines = String(umlText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const processes = [];

  if (diagramType === "sequence") {
    for (const line of lines) {
      if (line.includes("->")) {
        const match = line.match(/:\s*(.+)$/u);
        if (match?.[1]) {
          const action = match[1].trim();
          if (action && !processes.includes(action)) {
            processes.push(action);
          }
        }
      }
    }
  } else if (diagramType === "class") {
    let currentClass = "";
    for (const line of lines) {
      const classMatch = line.match(/^class\s+([^\s{]+)/iu);
      if (classMatch) {
        currentClass = classMatch[1].replace(/"/g, "");
        continue;
      }

      const methodMatch = line.match(/^[+\-#~]?\s*([A-Za-zА-Яа-яЁё_]\w*\s*\(.*\))/u);
      if (currentClass && methodMatch?.[1]) {
        const text = `${currentClass}: операция ${methodMatch[1].trim()}`;
        if (!processes.includes(text)) {
          processes.push(text);
        }
      }

      if (line.includes("--") && !line.startsWith("'")) {
        const relation = line.replace(/"/g, "").trim();
        const text = `Связь: ${relation}`;
        if (!processes.includes(text)) {
          processes.push(text);
        }
      }
    }
  } else if (diagramType === "use-case") {
    for (const line of lines) {
      if (/\busecase\b/iu.test(line)) {
        const quoted = line.match(/"([^"]+)"/u);
        if (quoted?.[1]) {
          const text = `Вариант использования: ${quoted[1].trim()}`;
          if (!processes.includes(text)) {
            processes.push(text);
          }
        } else {
          const raw = line.replace(/usecase/giu, "").trim();
          if (raw) {
            const text = `Вариант использования: ${raw}`;
            if (!processes.includes(text)) {
              processes.push(text);
            }
          }
        }
      }

      if (line.includes("--") && !line.startsWith("'")) {
        const relation = line.replace(/"/g, "").trim();
        const text = `Связь: ${relation}`;
        if (!processes.includes(text)) {
          processes.push(text);
        }
      }
    }
  }

  return processes.slice(0, 12);
}

function normalizePlantUmlOutput(rawText) {
  let text = String(rawText || "").trim();
  text = text.replace(/^```(?:plantuml|uml)?\s*/iu, "");
  text = text.replace(/\s*```$/u, "");

  const match = text.match(/@startuml[\s\S]*?@enduml/iu);
  if (match?.[0]) {
    text = match[0].trim();
  }

  if (!/@startuml/iu.test(text)) {
    text = `@startuml\n${text}`;
  }
  if (!/@enduml/iu.test(text)) {
    text = `${text}\n@enduml`;
  }

  return text;
}

function needsClassRepair(umlText) {
  const lower = String(umlText || "").toLowerCase();
  if (!lower.includes("class ")) {
    return true;
  }
  const markers = ["```", "объяснение", "пояснение", "шаг 1", "диаграмма:"];
  return markers.some((item) => lower.includes(item));
}

function looksNonRussianUml(umlText) {
  const withoutDirectives = String(umlText || "").replace(/^\s*@[a-zA-Z_]+\s*$/gmu, "");
  const withoutArrows = withoutDirectives.replace(/[-.<>:(){}[\]#/*_+=|\\]+/gu, " ");
  return !/[А-Яа-яЁё]/u.test(withoutArrows);
}

function hasLatinLabels(umlText) {
  const keywords = new Set([
    "startuml", "enduml", "participant", "actor", "boundary", "control", "entity",
    "database", "collections", "class", "interface", "enum", "abstract", "note",
    "left", "right", "of", "over", "as", "title", "skinparam", "autonumber",
    "activate", "deactivate", "return", "group", "alt", "else", "opt", "loop",
    "end", "package", "namespace", "usecase", "rectangle",
  ]);

  const matches = String(umlText || "").match(/[A-Za-z][A-Za-z0-9_-]*/g) || [];
  return matches.some((token) => !keywords.has(token.toLowerCase()));
}

async function rewriteUmlToRussianWithYandexGpt(umlText, diagramType) {
  const typeNames = {
    sequence: "диаграмма последовательности",
    class: "диаграмма классов",
    "use-case": "диаграмма вариантов использования",
  };

  const translated = await callYandexGpt(
    [
      {
        role: "system",
        text:
          "Перепиши только текстовые подписи PlantUML на русском языке. " +
          "В итоговой диаграмме не должно быть английских слов в подписях. " +
          "Структуру диаграммы, связи, участников и синтаксис PlantUML не меняй. " +
          "Верни только валидный код между @startuml и @enduml, без пояснений.",
      },
      {
        role: "user",
        text:
          `Ниже ${typeNames[diagramType] || "UML-диаграмма"}. ` +
          "Все подписи должны быть на русском языке. " +
          "Не меняй логику и структуру, измени только язык подписей:\n\n" +
          umlText,
      },
    ],
    1200
  );

  return normalizePlantUmlOutput(translated);
}

async function repairClassUmlWithYandexGpt(umlText) {
  const repaired = await callYandexGpt(
    [
      {
        role: "system",
        text:
          "Исправь синтаксис PlantUML для class diagram. " +
          "Верни только валидный код между @startuml и @enduml. " +
          "Ключевые слова PlantUML оставляй на английском, подписи и названия могут быть на русском.",
      },
      {
        role: "user",
        text: `Исправь этот PlantUML-код, не меняя смысл:\n\n${umlText}`,
      },
    ],
    1200
  );

  return normalizePlantUmlOutput(repaired);
}

async function repairUmlWithYandexGpt(umlText, diagramType) {
  const typeNames = {
    sequence: "диаграмма последовательности",
    class: "диаграмма классов",
    "use-case": "диаграмма вариантов использования",
  };

  const repaired = await callYandexGpt(
    [
      {
        role: "system",
        text:
          "Исправь синтаксис PlantUML. " +
          "Верни только валидный код между @startuml и @enduml. " +
          "Не добавляй пояснений. Ключевые слова PlantUML должны быть на английском.",
      },
      {
        role: "user",
        text:
          `Ниже код PlantUML для типа '${typeNames[diagramType] || "UML-диаграмма"}'. ` +
          "Исправь только синтаксис, сохрани смысл:\n\n" +
          umlText,
      },
    ],
    1200
  );

  return normalizePlantUmlOutput(repaired);
}

function encodePlantUmlText(text) {
  const compressed = zlib.deflateRawSync(Buffer.from(text, "utf8"));
  const encoded = [];

  for (let i = 0; i < compressed.length; i += 3) {
    const b1 = compressed[i];
    const b2 = i + 1 < compressed.length ? compressed[i + 1] : 0;
    const b3 = i + 2 < compressed.length ? compressed[i + 2] : 0;
    const c1 = b1 >> 2;
    const c2 = ((b1 & 0x3) << 4) | (b2 >> 4);
    const c3 = ((b2 & 0xf) << 2) | (b3 >> 6);
    const c4 = b3 & 0x3f;

    encoded.push(
      PLANTUML_ALPHABET[c1],
      PLANTUML_ALPHABET[c2],
      PLANTUML_ALPHABET[c3],
      PLANTUML_ALPHABET[c4]
    );
  }

  return encoded.join("");
}

function buildPlantUmlSvgUrl(umlText) {
  return `https://www.plantuml.com/plantuml/svg/${encodePlantUmlText(umlText)}`;
}

async function isValidPlantUml(umlText) {
  try {
    const svgUrl = buildPlantUmlSvgUrl(umlText);
    const response = await fetch(svgUrl);
    if (!response.ok) {
      return [false, `Ошибка проверки диаграммы: HTTP ${response.status}`];
    }

    const body = (await response.text()).toLowerCase();
    const errorMarkers = ["syntax error", "cannot parse", "error line", "parsing error"];
    if (errorMarkers.some((marker) => body.includes(marker))) {
      return [false, "PlantUML сообщает о синтаксической ошибке."];
    }
    return [true, ""];
  } catch (error) {
    return [false, `Ошибка проверки диаграммы: ${error.message}`];
  }
}

async function generateUmlWithYandexGpt(description, diagramType) {
  const typePrompts = {
    sequence: "диаграмма последовательности (sequence diagram)",
    class: "диаграмма классов (class diagram)",
    "use-case": "диаграмма вариантов использования (use-case diagram)",
  };

  let result = await callYandexGpt(
    [
      {
        role: "system",
        text:
          "Ты генерируешь только валидный код PlantUML. " +
          "Ответ должен быть только на русском и только в формате @startuml ... @enduml, без пояснений. " +
          "Ключевые слова PlantUML оставляй на английском. " +
          "Все подписи, сообщения, названия ролей/классов/вариантов использования должны быть на русском.",
      },
      {
        role: "user",
        text:
          "Сделай UML-диаграмму в формате PlantUML по описанию ниже. " +
          `Тип диаграммы: ${typePrompts[diagramType] || typePrompts.sequence}. ` +
          "Все подписи в диаграмме должны быть на русском языке. " +
          "Для class-диаграммы используй только корректный синтаксис PlantUML: class, interface, enum, " +
          "relation arrows (<|--, --|>, --, .., -->), атрибуты и методы внутри фигурных скобок.\n\n" +
          description,
      },
    ],
    1200
  );

  result = normalizePlantUmlOutput(result);
  if (diagramType === "class" && needsClassRepair(result)) {
    result = await repairClassUmlWithYandexGpt(result);
  }
  if (looksNonRussianUml(result) || hasLatinLabels(result)) {
    result = await rewriteUmlToRussianWithYandexGpt(result, diagramType);
  }

  for (let i = 0; i < 2; i += 1) {
    const [isValid] = await isValidPlantUml(result);
    if (isValid) {
      break;
    }
    result = await repairUmlWithYandexGpt(result, diagramType);
  }

  return result;
}

async function generateSmartProcessDescriptions(umlText, diagramType) {
  const typeNames = {
    sequence: "диаграмма последовательности",
    class: "диаграмма классов",
    "use-case": "диаграмма вариантов использования",
  };

  const responseText = await callYandexGpt(
    [
      {
        role: "system",
        text:
          "Ты технический аналитик. Пиши только на русском языке. " +
          "На основе PlantUML верни только нумерованный список шагов процесса, " +
          "без вступлений и без заключений.",
      },
      {
        role: "user",
        text:
          `Проанализируй ${typeNames[diagramType] || "UML-диаграмма"} и сформулируй 4-8 понятных шагов ` +
          'вида "Шаг 1: ...". Не копируй код, объясняй по-человечески.\n\n' +
          umlText,
      },
    ],
    700
  );

  const steps = parseSmartSteps(responseText);
  return steps.map((step, index) => `Шаг ${index + 1}: ${step}`);
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return response(405, { error: "Метод не поддерживается." });
  }

  try {
    const payload = JSON.parse(event.body || "{}");
    const description = String(payload.description || "").trim();
    const diagramType = String(payload.diagramType || "sequence");
    const accessCode = String(payload.accessCode || "").trim();

    if (!description) {
      return response(400, { error: "Введите текстовое описание." });
    }

    if (!["sequence", "class", "use-case"].includes(diagramType)) {
      return response(400, { error: "Некорректный тип диаграммы." });
    }

    const [isValidCode, codeError] = isAccessCodeValid(accessCode);
    if (!isValidCode) {
      return response(403, { error: codeError });
    }

    const umlText = await generateUmlWithYandexGpt(description, diagramType);
    const [isValid, validationError] = await isValidPlantUml(umlText);
    if (!isValid) {
      return response(500, {
        error: `Не удалось получить валидный PlantUML после автоисправления. ${validationError}`,
      });
    }

    const umlImageUrl = buildPlantUmlSvgUrl(umlText);
    let processDescriptions = [];

    if (diagramType !== "class") {
      try {
        processDescriptions = await generateSmartProcessDescriptions(umlText, diagramType);
      } catch {
        processDescriptions = extractProcessDescriptions(umlText, diagramType);
      }
    }

    return response(200, {
      diagramType,
      umlText,
      umlImageUrl,
      processDescriptions,
    });
  } catch (error) {
    return response(500, {
      error: `Ошибка обработки запроса: ${error.message}`,
    });
  }
};
