import os
import re
import zlib
from pathlib import Path

import requests
from flask import Flask, render_template, request
from dotenv import dotenv_values, load_dotenv

app = Flask(__name__)

PLANTUML_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_"

ENV_PATH = Path(__file__).with_name(".env")

# Always load .env from the project directory.
load_dotenv(dotenv_path=ENV_PATH, override=True)
DOTENV_VALUES = dotenv_values(ENV_PATH)


def _get_env_value(key: str) -> str:
    # Re-read .env on each call to avoid stale values in long-lived Flask processes.
    fresh_dotenv_values = dotenv_values(ENV_PATH)
    return (os.getenv(key) or DOTENV_VALUES.get(key) or fresh_dotenv_values.get(key) or "").strip()


def _get_yandex_credentials() -> tuple[str, str]:
    api_key = _get_env_value("YANDEX_API_KEY")
    folder_id = _get_env_value("YANDEX_FOLDER_ID")

    if not api_key or not folder_id:
        missing_keys = []
        if not api_key:
            missing_keys.append("YANDEX_API_KEY")
        if not folder_id:
            missing_keys.append("YANDEX_FOLDER_ID")
        raise ValueError(
            f"Отсутствуют переменные: {', '.join(missing_keys)}. "
            f"Проверьте файл {ENV_PATH.name} рядом с app.py и перезапустите приложение."
        )

    return api_key, folder_id


def _get_expected_access_code() -> str:
    return _get_env_value("ACCESS_CODE")


def _is_access_code_valid(user_code: str) -> tuple[bool, str]:
    expected_code = _get_expected_access_code()
    if not expected_code:
        return (
            False,
            f"В файле {ENV_PATH.name} не задан ACCESS_CODE. Добавьте его и перезапустите приложение.",
        )
    if not user_code:
        return False, "Введите код доступа."
    if user_code != expected_code:
        return False, "Неверный код доступа."
    return True, ""


def _call_yandexgpt(messages: list[dict[str, str]], max_tokens: int = 1200) -> str:
    api_key, folder_id = _get_yandex_credentials()
    url = "https://llm.api.cloud.yandex.net/foundationModels/v1/completion"
    headers = {
        "Authorization": f"Api-Key {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "modelUri": f"gpt://{folder_id}/yandexgpt/latest",
        "completionOptions": {"stream": False, "temperature": 0.3, "maxTokens": max_tokens},
        "messages": messages,
    }

    response = requests.post(url, headers=headers, json=payload, timeout=40)
    response.raise_for_status()
    data = response.json()
    return data["result"]["alternatives"][0]["message"]["text"].strip()


def _parse_smart_steps(raw_text: str) -> list[str]:
    steps: list[str] = []
    for line in raw_text.splitlines():
        text = line.strip()
        text = re.sub(r"^[-*•]\s*", "", text)
        text = re.sub(r"^\d+[.)]\s*", "", text)
        text = re.sub(r"^Шаг\s*\d+\s*:\s*", "", text, flags=re.IGNORECASE)
        if text:
            steps.append(text)

    unique_steps: list[str] = []
    for step in steps:
        if step not in unique_steps:
            unique_steps.append(step)

    return unique_steps[:10]


def extract_process_descriptions(uml_text: str, diagram_type: str) -> list[str]:
    lines = [line.strip() for line in uml_text.splitlines() if line.strip()]
    processes: list[str] = []

    if diagram_type == "sequence":
        for line in lines:
            if "->" in line or "-->" in line:
                match = re.search(r":\s*(.+)$", line)
                if match:
                    action_text = match.group(1).strip()
                    if action_text and action_text not in processes:
                        processes.append(action_text)

    elif diagram_type == "class":
        current_class = ""
        for line in lines:
            class_match = re.match(r"^class\s+([^\s\{]+)", line, flags=re.IGNORECASE)
            if class_match:
                current_class = class_match.group(1).strip('"')
                continue

            method_match = re.match(r"^[+\-#~]?\s*([A-Za-zА-Яа-я_]\w*\s*\(.*\))", line)
            if current_class and method_match:
                method_name = method_match.group(1).strip()
                text = f"{current_class}: операция {method_name}"
                if text not in processes:
                    processes.append(text)

            if "--" in line and not line.startswith("'"):
                relation = line.replace('"', "").strip()
                text = f"Связь: {relation}"
                if text not in processes:
                    processes.append(text)

    elif diagram_type == "use-case":
        for line in lines:
            if re.search(r"\busecase\b", line, flags=re.IGNORECASE):
                quoted = re.search(r'"([^"]+)"', line)
                if quoted:
                    name = quoted.group(1).strip()
                    text = f"Вариант использования: {name}"
                    if text not in processes:
                        processes.append(text)
                else:
                    raw = line.replace("usecase", "").strip()
                    if raw:
                        text = f"Вариант использования: {raw}"
                        if text not in processes:
                            processes.append(text)

            if "--" in line and not line.startswith("'"):
                relation = line.replace('"', "").strip()
                text = f"Связь: {relation}"
                if text not in processes:
                    processes.append(text)

    return processes[:12]


def _normalize_plantuml_output(raw_text: str) -> str:
    text = (raw_text or "").strip()

    # Remove common markdown fences if the model wraps output in ``` blocks.
    text = re.sub(r"^```(?:plantuml|uml)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text)

    # Keep only the PlantUML block if there is extra commentary.
    match = re.search(r"@startuml[\s\S]*?@enduml", text, flags=re.IGNORECASE)
    if match:
        text = match.group(0).strip()

    if not re.search(r"@startuml", text, flags=re.IGNORECASE):
        text = "@startuml\n" + text
    if not re.search(r"@enduml", text, flags=re.IGNORECASE):
        text = text + "\n@enduml"

    return text


def _needs_class_repair(uml_text: str) -> bool:
    lower_text = uml_text.lower()
    if "class " not in lower_text:
        return True
    invalid_markers = ("```", "объяснение", "пояснение", "шаг 1", "диаграмма:")
    return any(marker in lower_text for marker in invalid_markers)


def _looks_non_russian_uml(uml_text: str) -> bool:
    # Ignore PlantUML directives and look at human-readable labels.
    text_without_directives = re.sub(r"^\s*@[a-zA-Z_]+\s*$", "", uml_text, flags=re.MULTILINE)
    text_without_arrows = re.sub(r"[-.<>:(){}[\]#/*_+=|\\]+", " ", text_without_directives)
    return not re.search(r"[А-Яа-яЁё]", text_without_arrows)


def _has_latin_labels(uml_text: str) -> bool:
    # Skip common PlantUML keywords and directives, detect latin words in labels.
    keywords = {
        "startuml",
        "enduml",
        "participant",
        "actor",
        "boundary",
        "control",
        "entity",
        "database",
        "collections",
        "class",
        "interface",
        "enum",
        "abstract",
        "note",
        "left",
        "right",
        "of",
        "over",
        "as",
        "title",
        "skinparam",
        "autonumber",
        "activate",
        "deactivate",
        "return",
        "group",
        "alt",
        "else",
        "opt",
        "loop",
        "end",
        "package",
        "namespace",
        "usecase",
        "rectangle",
    }
    for token in re.findall(r"[A-Za-z][A-Za-z0-9_-]*", uml_text):
        if token.lower() not in keywords:
            return True
    return False


def _rewrite_uml_to_russian_with_yandexgpt(uml_text: str, diagram_type: str) -> str:
    type_names = {
        "sequence": "диаграмма последовательности",
        "class": "диаграмма классов",
        "use-case": "диаграмма вариантов использования",
    }
    type_name = type_names.get(diagram_type, "UML-диаграмма")
    translated = _call_yandexgpt(
        messages=[
            {
                "role": "system",
                "text": (
                    "Перепиши только текстовые подписи PlantUML на русском языке. "
                    "В итоговой диаграмме не должно быть английских слов в подписях. "
                    "Структуру диаграммы, связи, участников и синтаксис PlantUML не меняй. "
                    "Верни только валидный код между @startuml и @enduml, без пояснений."
                ),
            },
            {
                "role": "user",
                "text": (
                    f"Ниже {type_name}. Все подписи должны быть на русском языке. "
                    "Не меняй логику и структуру, измени только язык подписей:\n\n"
                    f"{uml_text}"
                ),
            },
        ],
        max_tokens=1200,
    )
    return _normalize_plantuml_output(translated)


def _repair_class_uml_with_yandexgpt(uml_text: str) -> str:
    repaired = _call_yandexgpt(
        messages=[
            {
                "role": "system",
                "text": (
                    "Исправь синтаксис PlantUML для class diagram. "
                    "Верни только валидный код между @startuml и @enduml. "
                    "Ключевые слова PlantUML оставляй на английском, подписи и названия могут быть на русском."
                ),
            },
            {
                "role": "user",
                "text": f"Исправь этот PlantUML-код, не меняя смысл:\n\n{uml_text}",
            },
        ],
        max_tokens=1200,
    )
    return _normalize_plantuml_output(repaired)


def _repair_uml_with_yandexgpt(uml_text: str, diagram_type: str) -> str:
    type_names = {
        "sequence": "диаграмма последовательности",
        "class": "диаграмма классов",
        "use-case": "диаграмма вариантов использования",
    }
    type_name = type_names.get(diagram_type, "UML-диаграмма")
    repaired = _call_yandexgpt(
        messages=[
            {
                "role": "system",
                "text": (
                    "Исправь синтаксис PlantUML. "
                    "Верни только валидный код между @startuml и @enduml. "
                    "Не добавляй пояснений. Ключевые слова PlantUML должны быть на английском."
                ),
            },
            {
                "role": "user",
                "text": (
                    f"Ниже код PlantUML для типа '{type_name}'. "
                    "Исправь только синтаксис, сохрани смысл:\n\n"
                    f"{uml_text}"
                ),
            },
        ],
        max_tokens=1200,
    )
    return _normalize_plantuml_output(repaired)


def _encode_plantuml_text(text: str) -> str:
    compressed = zlib.compress(text.encode("utf-8"))[2:-4]
    encoded = []
    for i in range(0, len(compressed), 3):
        b1 = compressed[i]
        b2 = compressed[i + 1] if i + 1 < len(compressed) else 0
        b3 = compressed[i + 2] if i + 2 < len(compressed) else 0
        c1 = b1 >> 2
        c2 = ((b1 & 0x3) << 4) | (b2 >> 4)
        c3 = ((b2 & 0xF) << 2) | (b3 >> 6)
        c4 = b3 & 0x3F
        encoded.extend(
            [
                PLANTUML_ALPHABET[c1],
                PLANTUML_ALPHABET[c2],
                PLANTUML_ALPHABET[c3],
                PLANTUML_ALPHABET[c4],
            ]
        )
    return "".join(encoded)


def _build_plantuml_svg_url(uml_text: str) -> str:
    return f"https://www.plantuml.com/plantuml/svg/{_encode_plantuml_text(uml_text)}"


def _is_valid_plantuml(uml_text: str) -> tuple[bool, str]:
    try:
        svg_url = _build_plantuml_svg_url(uml_text)
        response = requests.get(svg_url, timeout=25)
        response.raise_for_status()
    except requests.RequestException as exc:
        return False, f"Ошибка проверки диаграммы: {exc}"

    lowered = response.text.lower()
    error_markers = (
        "syntax error",
        "cannot parse",
        "error line",
        "parsing error",
    )
    if any(marker in lowered for marker in error_markers):
        return False, "PlantUML сообщает о синтаксической ошибке."
    return True, ""


def generate_uml_with_yandexgpt(description: str, diagram_type: str) -> str:
    type_prompts = {
        "sequence": "диаграмма последовательности (sequence diagram)",
        "class": "диаграмма классов (class diagram)",
        "use-case": "диаграмма вариантов использования (use-case diagram)",
    }
    diagram_type_prompt = type_prompts.get(diagram_type, type_prompts["sequence"])

    result = _call_yandexgpt(
        messages=[
            {
                "role": "system",
                "text": (
                    "Ты генерируешь только валидный код PlantUML. "
                    "Ответ должен быть только на русском и только в формате @startuml ... @enduml, без пояснений. "
                    "Ключевые слова PlantUML оставляй на английском. "
                    "Все подписи, сообщения, названия ролей/классов/вариантов использования должны быть на русском."
                ),
            },
            {
                "role": "user",
                "text": (
                    "Сделай UML-диаграмму в формате PlantUML по описанию ниже. "
                    f"Тип диаграммы: {diagram_type_prompt}. "
                    "Все подписи в диаграмме должны быть на русском языке. "
                    "Для class-диаграммы используй только корректный синтаксис PlantUML: class, interface, enum, "
                    "relation arrows (<|--, --|>, --, .., -->), атрибуты и методы внутри фигурных скобок.\n\n"
                    f"{description}"
                ),
            },
        ],
        max_tokens=1200,
    )
    result = _normalize_plantuml_output(result)
    if diagram_type == "class" and _needs_class_repair(result):
        result = _repair_class_uml_with_yandexgpt(result)
    if _looks_non_russian_uml(result) or _has_latin_labels(result):
        result = _rewrite_uml_to_russian_with_yandexgpt(result, diagram_type)

    # Validate and auto-repair up to two times if PlantUML reports syntax issues.
    for _ in range(2):
        is_valid, _ = _is_valid_plantuml(result)
        if is_valid:
            break
        result = _repair_uml_with_yandexgpt(result, diagram_type)

    return result


def generate_smart_process_descriptions(uml_text: str, diagram_type: str) -> list[str]:
    type_names = {
        "sequence": "диаграмма последовательности",
        "class": "диаграмма классов",
        "use-case": "диаграмма вариантов использования",
    }
    type_name = type_names.get(diagram_type, "UML-диаграмма")
    response_text = _call_yandexgpt(
        messages=[
            {
                "role": "system",
                "text": (
                    "Ты технический аналитик. Пиши только на русском языке. "
                    "На основе PlantUML верни только нумерованный список шагов процесса, "
                    "без вступлений и без заключений."
                ),
            },
            {
                "role": "user",
                "text": (
                    f"Проанализируй {type_name} и сформулируй 4-8 понятных шагов вида "
                    '"Шаг 1: ...". Не копируй код, объясняй по-человечески.\n\n'
                    f"{uml_text}"
                ),
            },
        ],
        max_tokens=700,
    )

    steps = _parse_smart_steps(response_text)
    if steps:
        return [f"Шаг {index + 1}: {step}" for index, step in enumerate(steps)]
    return []


@app.route("/", methods=["GET", "POST"])
def home():
    description = ""
    diagram_type = "sequence"
    access_code = ""
    uml_text = ""
    uml_image_url = ""
    process_descriptions: list[str] = []
    error_message = ""

    if request.method == "POST":
        description = request.form.get("description", "").strip()
        diagram_type = request.form.get("diagram_type", "sequence")
        access_code = request.form.get("access_code", "").strip()
        if description:
            is_access_valid, access_error = _is_access_code_valid(access_code)
            if not is_access_valid:
                error_message = access_error
            else:
                try:
                    uml_text = generate_uml_with_yandexgpt(description, diagram_type)
                    is_valid, validation_error = _is_valid_plantuml(uml_text)
                    if not is_valid:
                        raise ValueError(
                            "Не удалось получить валидный PlantUML после автоисправления. "
                            f"{validation_error}"
                        )
                    uml_image_url = _build_plantuml_svg_url(uml_text)
                    if diagram_type != "class":
                        try:
                            process_descriptions = generate_smart_process_descriptions(uml_text, diagram_type)
                        except (requests.RequestException, KeyError, ValueError):
                            process_descriptions = extract_process_descriptions(uml_text, diagram_type)
                except requests.RequestException as exc:
                    error_message = f"Ошибка запроса к YandexGPT: {exc}"
                except (KeyError, ValueError) as exc:
                    error_message = f"Ошибка обработки ответа: {exc}"
        else:
            error_message = "Введите текстовое описание."

    return render_template(
        "index.html",
        description=description,
        diagram_type=diagram_type,
        access_code=access_code,
        uml_text=uml_text,
        uml_image_url=uml_image_url,
        process_descriptions=process_descriptions,
        error_message=error_message,
    )


if __name__ == "__main__":
    app.run(debug=True)
