const umlForm = document.getElementById("umlForm");
const submitButton = document.getElementById("submitButton");
const loadingOverlay = document.getElementById("loadingOverlay");
const loadingText = document.getElementById("loadingText");
const copyButton = document.getElementById("copyUmlButton");
const umlOutput = document.getElementById("umlOutput");
const umlPlaceholder = document.getElementById("umlPlaceholder");
const umlImage = document.getElementById("umlImage");
const imagePlaceholder = document.getElementById("imagePlaceholder");
const processList = document.getElementById("processList");
const processPlaceholder = document.getElementById("processPlaceholder");
const errorBox = document.getElementById("errorBox");

function setLoading(isLoading) {
  if (!submitButton || !loadingOverlay || !loadingText) {
    return;
  }

  if (isLoading) {
    submitButton.disabled = true;
    submitButton.innerText = "Генерируем...";
    loadingOverlay.classList.remove("hidden");
    return;
  }

  submitButton.disabled = false;
  submitButton.innerText = "Сгенерировать UML";
  loadingOverlay.classList.add("hidden");
  loadingText.innerText = "Обрабатываем запрос...";
}

function showError(message) {
  if (!errorBox) {
    return;
  }
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
}

function hideError() {
  if (!errorBox) {
    return;
  }
  errorBox.textContent = "";
  errorBox.classList.add("hidden");
}

function renderResult(data) {
  const { umlText, umlImageUrl, processDescriptions, diagramType } = data;

  if (umlOutput && umlPlaceholder && copyButton) {
    umlOutput.innerText = umlText || "";
    umlOutput.classList.toggle("hidden", !umlText);
    umlPlaceholder.classList.toggle("hidden", Boolean(umlText));
    copyButton.classList.toggle("hidden", !umlText);
  }

  if (umlImage && imagePlaceholder) {
    umlImage.src = umlImageUrl || "";
    umlImage.classList.toggle("hidden", !umlImageUrl);
    imagePlaceholder.classList.toggle("hidden", Boolean(umlImageUrl));
  }

  if (processList && processPlaceholder) {
    processList.innerHTML = "";
    if (diagramType === "class") {
      processPlaceholder.textContent = "Для диаграммы классов описание процессов не формируется.";
      processList.classList.add("hidden");
      processPlaceholder.classList.remove("hidden");
      return;
    }

    if (Array.isArray(processDescriptions) && processDescriptions.length > 0) {
      processDescriptions.forEach((processText) => {
        const li = document.createElement("li");
        li.textContent = processText;
        processList.appendChild(li);
      });
      processList.classList.remove("hidden");
      processPlaceholder.classList.add("hidden");
    } else {
      processList.classList.add("hidden");
      processPlaceholder.classList.remove("hidden");
      processPlaceholder.textContent = "Процессы не найдены.";
    }
  }
}

if (umlForm) {
  umlForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideError();
    setLoading(true);

    let dotCount = 0;
    const dotTimer = setInterval(() => {
      dotCount = (dotCount + 1) % 4;
      if (loadingText) {
        loadingText.innerText = `Обрабатываем запрос${".".repeat(dotCount)}`;
      }
    }, 400);

    try {
      const formData = new FormData(umlForm);
      const payload = {
        accessCode: String(formData.get("accessCode") || "").trim(),
        description: String(formData.get("description") || "").trim(),
        diagramType: String(formData.get("diagramType") || "sequence"),
      };

      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Ошибка генерации.");
      }

      renderResult(data);
    } catch (error) {
      showError(error.message || "Произошла непредвиденная ошибка.");
    } finally {
      clearInterval(dotTimer);
      setLoading(false);
    }
  });
}

if (copyButton && umlOutput) {
  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(umlOutput.innerText);
      const initialText = copyButton.innerText;
      copyButton.innerText = "Скопировано!";
      setTimeout(() => {
        copyButton.innerText = initialText;
      }, 1200);
    } catch {
      copyButton.innerText = "Ошибка копирования";
      setTimeout(() => {
        copyButton.innerText = "Скопировать PlantUML";
      }, 1500);
    }
  });
}
