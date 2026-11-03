const $ = id => document.getElementById(id);

const CONFIG = {
  PAPEROFFICE_API_KEY: "po_pk_910557515_de081807349357782b45fb50b60c5e0c484a42e7a1b6410c",
  API_BASE_URL: "https://api.paperoffice.ai/latest",
  MAX_FILE_SIZE: 25 * 1024 * 1024,
  MAX_FILES: 5
};

const ui = {
  sidebar: $("sidebar"), welcome: $("welcome"), messages: $("messages"), input: $("messageInput"),
  send: $("sendButton"), fileInput: $("fileInput"), attachments: $("attachments"),
  historySection: $("historySection"), historyList: $("historyList"), modal: $("modal"), toast: $("toast"),
  feature: $("featureSelect"), toolOptions: $("toolOptions"), languageOptions: $("languageOptions"),
  lookupOptions: $("lookupOptions"), currencyOptions: $("currencyOptions"), lookupInput: $("lookupInput")
};

let currentUser = null;
let chats = [];
let activeChatId = null;
let pendingFiles = [];
let toastTimer;
let sending = false;

function id() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function activeChat() { return chats.find(chat => chat.id === activeChatId) || null; }

function showToast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove("show"), 3000);
}

function openModal(title, description, note) {
  $("modalTitle").textContent = title;
  $("modalDescription").textContent = description;
  $("modalNote").textContent = note || "";
  ui.modal.hidden = false;
}

function closeModal() { ui.modal.hidden = true; }

function createChat() {
  const chat = { id: id(), title: "New conversation", messages: [], updatedAt: Date.now() };
  chats.unshift(chat);
  activeChatId = chat.id;
  renderHistory();
  renderMessages();
  return chat;
}

function renderHistory() {
  ui.historyList.replaceChildren();
  ui.historySection.hidden = !currentUser;
  if (!currentUser) return;

  if (!chats.length) {
    const empty = document.createElement("p");
    empty.className = "empty-history";
    empty.textContent = "No saved conversations yet.";
    ui.historyList.append(empty);
    return;
  }

  chats.forEach(chat => {
    const button = document.createElement("button");
    button.className = "history-item";
    button.textContent = chat.title;
    button.classList.toggle("active", chat.id === activeChatId);
    button.addEventListener("click", () => {
      activeChatId = chat.id;
      renderHistory();
      renderMessages();
      closeSidebar();
    });
    ui.historyList.append(button);
  });
}

function downloadFile(filename, content, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function addText(parent, text) {
  const paragraph = document.createElement("div");
  paragraph.className = "message-text";
  paragraph.textContent = text;
  parent.append(paragraph);
}

function renderRichText(parent, content) {
  const parts = content.split(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g);

  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 0) {
      if (parts[i]) addText(parent, parts[i]);
    } else {
      const wrapper = document.createElement("div");
      wrapper.className = "code-block";

      const header = document.createElement("div");
      header.className = "code-header";

      const language = document.createElement("span");
      language.textContent = parts[i] || "code";

      const actions = document.createElement("div");
      const codeText = parts[i + 1];

      const copy = document.createElement("button");
      copy.textContent = "Copy";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(codeText);
          copy.textContent = "Copied!";
          setTimeout(() => copy.textContent = "Copy", 1500);
        } catch {
          showToast("Clipboard access was blocked.");
        }
      });

      const download = document.createElement("button");
      download.textContent = "Download";
      download.addEventListener("click", () => downloadFile("veditalk-code.txt", codeText));

      actions.append(copy, download);
      header.append(language, actions);

      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = codeText;
      pre.append(code);

      wrapper.append(header, pre);
      parent.append(wrapper);
      i++;
    }
  }
}

function renderMessages() {
  const chat = activeChat();
  ui.messages.replaceChildren();

  if (!chat || chat.messages.length === 0) {
    ui.welcome.hidden = false;
    ui.messages.classList.remove("visible");
    return;
  }

  ui.welcome.hidden = true;
  ui.messages.classList.add("visible");

  chat.messages.forEach(message => {
    const row = document.createElement("article");
    row.className = `message ${message.role}`;

    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.textContent = message.role === "assistant" ? "✦" : "Q";

    const content = document.createElement("div");
    content.className = "message-content";

    const name = document.createElement("p");
    name.className = "message-name";
    name.textContent = message.role === "assistant" ? "Veditalk" : "You";
    content.append(name);

    if (message.content) renderRichText(content, message.content);

    if (message.media?.length) {
      const gallery = document.createElement("div");
      gallery.className = "message-gallery";

      message.media.forEach(item => {
        if (item.type?.startsWith("image/") && item.url) {
          const img = document.createElement("img");
          img.src = item.url;
          img.alt = item.name || "Generated image";
          gallery.append(img);
        } else if (item.type?.startsWith("audio/") && item.url) {
          const audio = document.createElement("audio");
          audio.controls = true;
          audio.src = item.url;
          gallery.append(audio);
        } else if (item.url) {
          const link = document.createElement("a");
          link.href = item.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = item.name || "Open result";
          gallery.append(link);
        }
      });

      content.append(gallery);
    }

    const actions = document.createElement("div");
    actions.className = "message-actions";

    if (message.role === "assistant" && message.content) {
      const download = document.createElement("button");
      download.className = "message-action";
      download.textContent = "↓ Download reply";
      download.addEventListener("click", () => downloadFile("veditalk-reply.txt", message.content));
      actions.append(download);
    }

    if (actions.children.length) content.append(actions);
    row.append(avatar, content);
    ui.messages.append(row);
  });

  ui.messages.scrollTop = ui.messages.scrollHeight;
}

function addMessage(role, content, media = []) {
  let chat = activeChat();
  if (!chat) chat = createChat();

  const message = { id: id(), role, content, media, createdAt: Date.now() };
  chat.messages.push(message);
  chat.updatedAt = Date.now();

  if (role === "user" && chat.title === "New conversation") {
    const title = content || "File request";
    chat.title = title.length > 35 ? `${title.slice(0, 35)}…` : title;
  }

  renderMessages();
  renderHistory();
  return message;
}

function renderAttachments() {
  ui.attachments.replaceChildren();
  ui.attachments.hidden = pendingFiles.length === 0;

  pendingFiles.forEach((item, index) => {
    const card = document.createElement("div");
    card.className = "attachment";

    if (item.type.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = item.preview;
      img.alt = item.name;
      card.append(img);
    }

    const name = document.createElement("span");
    name.textContent = item.name;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";

    remove.addEventListener("click", () => {
      if (item.preview) URL.revokeObjectURL(item.preview);
      pendingFiles.splice(index, 1);
      renderAttachments();
      updateSendButton();
    });

    card.append(name, remove);
    ui.attachments.append(card);
  });
}

function selectFiles(files) {
  for (const file of Array.from(files)) {
    if (pendingFiles.length >= CONFIG.MAX_FILES) {
      showToast(`Maximum ${CONFIG.MAX_FILES} files per request.`);
      break;
    }

    if (file.size > CONFIG.MAX_FILE_SIZE) {
      showToast(`${file.name} is larger than 25 MB.`);
      continue;
    }

    const allowed =
      file.type.startsWith("image/") ||
      file.type.startsWith("audio/") ||
      file.type === "application/pdf" ||
      /\.docx?$/i.test(file.name);

    if (!allowed) {
      showToast(`${file.name}: unsupported file type.`);
      continue;
    }

    pendingFiles.push({
      file,
      name: file.name,
      type: file.type || "application/octet-stream",
      preview: file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : ""
    });
  }

  renderAttachments();
  updateSendButton();
}

function getApiKey() {
  const key = CONFIG.PAPEROFFICE_API_KEY.trim();

  if (!key || key.includes("PASTE_YOUR")) {
    throw new Error("Add your PaperOffice Publishable Key in CONFIG at the top of script.js.");
  }

  if (!key.startsWith("po_pk_")) {
    throw new Error("Use a PaperOffice Publishable Key beginning with po_pk_. Never put a secret key in this file.");
  }

  return key;
}

async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${getApiKey()}`);

  const response = await fetch(`${CONFIG.API_BASE_URL}${path}`, {
    ...options,
    headers
  });

  const contentType = response.headers.get("content-type") || "";

  const data = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const detail = typeof data === "string"
      ? data
      : data.message || data.error || data.code || JSON.stringify(data);

    throw new Error(`PaperOffice error ${response.status}: ${detail}`);
  }

  return data;
}

function formData(fields, fileField, file) {
  const body = new FormData();

  Object.entries(fields).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      body.append(key, String(value));
    }
  });

  if (file && fileField) {
    body.append(fileField, file, file.name);
  }

  return body;
}

function extractReadable(value, depth = 0) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (depth > 5) return JSON.stringify(value);

  if (Array.isArray(value)) {
    return value
      .map(item => extractReadable(item, depth + 1))
      .filter(Boolean)
      .join("\n");
  }

  if (typeof value === "object") {
    const preferred = [
      "text",
      "extracted_text",
      "ocr_text",
      "transcription",
      "transcript",
      "translation",
      "summary",
      "content",
      "message",
      "description",
      "result"
    ];

    const parts = [];

    for (const key of preferred) {
      if (value[key] !== undefined) {
        const text = extractReadable(value[key], depth + 1);

        if (text && !parts.includes(text)) {
          parts.push(text);
        }
      }
    }

    if (parts.length) return parts.join("\n\n");

    return JSON.stringify(value, null, 2);
  }

  return String(value);
}

async function pollJob(jobId) {
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5000));

    const result = await apiRequest(
      `/job/get/${encodeURIComponent(jobId)}?compact=false`
    );

    if (result.job_status === "completed") {
      return result.result ?? result.job_result ?? result;
    }

    if (result.job_status === "failed") {
      throw new Error(
        result.message || result.error || "PaperOffice job failed."
      );
    }
  }

  throw new Error(`This job is taking longer than expected. Job ID: ${jobId}`);
}

async function submitJob(pipeline, body) {
  const response = await apiRequest(`/job/add/${pipeline}`, {
    method: "POST",
    body
  });

  if (response.job_status === "completed") {
    return response.result ?? response.job_result ?? response;
  }

  if (response.job_id) {
    return pollJob(response.job_id);
  }

  if (
    response.result !== undefined ||
    response.job_result !== undefined
  ) {
    return response.result ?? response.job_result;
  }

  return response;
}

function getFirstFile(typePrefix) {
  return pendingFiles.find(item => item.type.startsWith(typePrefix))?.file || null;
}

function requireFile(typePrefix, label) {
  const file = getFirstFile(typePrefix);

  if (!file) {
    throw new Error(`Attach a ${label} file first.`);
  }

  return file;
}

async function runOCR(file, handwriting = false) {
  const fields = handwriting
    ? {
        model: "ultra",
        idp_collection: "handwritten_document",
        processing_lane: "no_sla"
      }
    : {
        ocr_mode: "text",
        output_searchable_pdf: "false",
        processing_lane: "no_sla"
      };

  return submitJob(
    "paperoffice_aiocr___generate",
    formData(fields, "file_1", file)
  );
}

async function runDocumentAnalysis(file, collection = "document_analysis", fields = null) {
  const options = {
    model: "premium",
    idp_collection: collection,
    processing_lane: "no_sla"
  };

  if (fields) {
    options.idp_fields = JSON.stringify(fields);
  }

  return apiRequest("/documents/document-analysis", {
    method: "POST",
    body: formData(options, "file_1", file)
  });
}

function getDocumentFile() {
  return pendingFiles.find(item =>
    item.type.startsWith("image/") ||
    item.type === "application/pdf" ||
    item.name.toLowerCase().endsWith(".pdf")
  )?.file || null;
}

async function runFeature(feature, prompt) {
  const file = getDocumentFile();

  if (feature === "chat") {
    throw new Error(
      "PaperOffice's current public API documentation does not provide a general chat-completions endpoint. The llm:generate permission is a scope, not an endpoint. I have not invented a URL."
    );
  }

  if (feature === "ocr") {
    if (!file) throw new Error("Attach an image or PDF first.");
    return runOCR(file, false);
  }

  if (feature === "handwriting") {
    if (!file) {
      throw new Error("Attach a scan or photo of the handwritten page first.");
    }

    return runOCR(file, true);
  }

  if (feature === "summarize") {
    if (!file) {
      throw new Error("Attach a PDF or image document to summarize.");
    }

    return runDocumentAnalysis(file);
  }

  if (feature === "image-analyze") {
    return runDocumentAnalysis(
      requireFile("image/", "image"),
      "document_analysis"
    );
  }

  if (feature === "extract") {
    if (!file) {
      throw new Error("Attach a document or image first.");
    }

    return runDocumentAnalysis(file, "document_analysis", [
      {
        key: "person_names",
        description: "Names of people mentioned in the document"
      },
      {
        key: "organization_names",
        description: "Names of companies and organizations"
      },
      {
        key: "dates",
        description: "Dates mentioned in the document"
      },
      {
        key: "addresses",
        description: "Postal and street addresses"
      },
      {
        key: "email_addresses",
        description: "Email addresses"
      },
      {
        key: "phone_numbers",
        description: "Phone numbers"
      }
    ]);
  }

  if (feature === "translate") {
    if (!prompt) {
      throw new Error("Enter the text you want to translate.");
    }

    return apiRequest("/translate/text", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text: prompt,
        source_language: "auto",
        target_language: $("targetLanguage").value,
        tier: "premium",
        client_wait: true
      })
    });
  }

  if (feature === "tts") {
    if (!prompt) {
      throw new Error("Enter the text you want Veditalk to read aloud.");
    }

    return submitJob(
      "paperoffice_voice___tts",
      formData({
        text: prompt,
        voice: "Abigail",
        language: "en",
        quality: "premium",
        output_format: "mp3",
        output: "url",
        processing_lane: "no_sla"
      })
    );
  }

  if (feature === "stt") {
    const audio = requireFile("audio/", "audio");

    return submitJob(
      "paperoffice_voice___stt",
      formData({
        quality: "basic",
        output_format: "json",
        processing_lane: "no_sla"
      }, "audio_file", audio)
    );
  }

  if (feature === "image-gen") {
    if (!prompt) {
      throw new Error("Describe the image you want to generate.");
    }

    return submitJob(
      "paperoffice_imagestudio___generate",
      formData({
        prompt,
        model: "premium",
        output: "url",
        num_images: 1,
        precompile_prompt: "true",
        inject_weather: "false",
        processing_lane: "no_sla"
      })
    );
  }

  if (feature === "currency") {
    const amount = Number($("currencyAmount").value);

    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error("Enter a valid amount.");
    }

    return apiRequest("/currency_exchange/convert", {
      method: "POST",
      body: formData({
        from: $("currencyFrom").value,
        to: $("currencyTo").value,
        amount
      })
    });
  }

  if (feature === "weather") {
    const city = ui.lookupInput.value.trim();

    if (!city) throw new Error("Enter a city name.");

    return apiRequest(
      `/weather?city=${encodeURIComponent(city)}&lang=en`
    );
  }

  if (feature === "address") {
    const address = ui.lookupInput.value.trim();

    if (!address) {
      throw new Error("Enter an address or place name.");
    }

    return apiRequest("/geocoding/forward", {
      method: "POST",
      body: formData({
        address,
        lang: "en"
      })
    });
  }

  if (feature === "sentiment") {
    throw new Error(
      "The documented sentiment endpoint reads CRM account sentiment history. It does not analyze arbitrary text, and this app's key intentionally has no account-data access."
    );
  }

  if (feature === "demo") {
    const response = await fetch(`${CONFIG.API_BASE_URL}/health`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "PaperOffice health check failed.");
    }

    return data;
  }

  throw new Error("This tool is not connected yet.");
}

function findUrls(value, output = [], depth = 0) {
  if (!value || depth > 6) return output;

  if (typeof value === "string") {
    output.push(...(value.match(/https?:\/\/[^\s"'<>]+/g) || []));
  } else if (Array.isArray(value)) {
    value.forEach(item => findUrls(item, output, depth + 1));
  } else if (typeof value === "object") {
    Object.values(value).forEach(item => findUrls(item, output, depth + 1));
  }

  return output;
}

function formatFeatureResult(feature, result) {
  const text = extractReadable(result);
  const urls = findUrls(result);
  const media = [];

  const downloadUrl = urls.find(url =>
    url.includes("/job/download/")
  );

  if (downloadUrl) {
    media.push({
      name: feature === "image-gen" ? "Generated image" : "Open result file",
      url: downloadUrl,
      type: feature === "image-gen" ? "image/*" : "application/octet-stream"
    });
  }

  const audioUrl = result?.audio_url || result?.url || result?.download_url;

  if (
    feature === "tts" &&
    typeof audioUrl === "string" &&
    audioUrl.startsWith("http")
  ) {
    media.push({
      name: "Generated speech",
      url: audioUrl,
      type: "audio/mpeg"
    });
  }

  if (
    feature === "image-gen" &&
    !media.length &&
    typeof audioUrl === "string" &&
    audioUrl.startsWith("http")
  ) {
    media.push({
      name: "Generated image",
      url: audioUrl,
      type: "image/*"
    });
  }

  return {
    text: text || JSON.stringify(result, null, 2),
    media
  };
}

async function sendMessage() {
  if (sending) return;

  const prompt = ui.input.value.trim();
  const feature = ui.feature.value;
  const noTextNeeded = ["currency", "weather", "address", "demo"].includes(feature);

  if (!prompt && pendingFiles.length === 0 && !noTextNeeded) return;

  sending = true;
  updateSendButton();

  const fileNames = pendingFiles.map(item => item.name);

  addMessage(
    "user",
    [
      prompt,
      fileNames.length ? `Attached: ${fileNames.join(", ")}` : ""
    ].filter(Boolean).join("\n")
  );

  ui.input.value = "";
  ui.input.style.height = "auto";

  const loading = addMessage("assistant", "Working with PaperOffice…");

  try {
    const result = await runFeature(feature, prompt);
    const formatted = formatFeatureResult(feature, result);

    loading.content = formatted.text;
    loading.media = formatted.media;

    renderMessages();
  } catch (error) {
    loading.content = `Couldn't complete that request.\n\n${error.message}`;
    renderMessages();
  } finally {
    pendingFiles.forEach(item => {
      if (item.preview) URL.revokeObjectURL(item.preview);
    });

    pendingFiles = [];
    renderAttachments();
    sending = false;
    updateSendButton();
    ui.input.focus();
  }
}

function updateSendButton() {
  const noTextNeeded = ["currency", "weather", "address", "demo"].includes(ui.feature.value);

  ui.send.disabled =
    sending ||
    (!ui.input.value.trim() && pendingFiles.length === 0 && !noTextNeeded);
}

function updateFeatureOptions() {
  const feature = ui.feature.value;

  ui.toolOptions.hidden =
    !["translate", "weather", "address", "currency"].includes(feature);

  ui.languageOptions.hidden = feature !== "translate";
  ui.lookupOptions.hidden = !["weather", "address"].includes(feature);
  ui.currencyOptions.hidden = feature !== "currency";

  if (feature === "weather") {
    $("lookupLabel").textContent = "CITY";
    ui.lookupInput.placeholder = "e.g. Kuala Lumpur";
  }

  if (feature === "address") {
    $("lookupLabel").textContent = "ADDRESS OR PLACE";
    ui.lookupInput.placeholder = "Enter an address or place";
  }

  const placeholders = {
    chat: "Chat endpoint is not documented yet...",
    ocr: "Attach an image or PDF to read...",
    translate: "Enter text to translate...",
    summarize: "Attach a document to summarize...",
    "image-analyze": "Attach an image to analyze...",
    handwriting: "Attach a handwritten page...",
    sentiment: "Sentiment analysis is not available for arbitrary text yet...",
    extract: "Attach a document to extract text from...",
    tts: "Enter text for Veditalk to read aloud...",
    stt: "Attach an audio file to transcribe...",
    "image-gen": "Describe the image you want to create...",
    currency: "Set the amount and currencies above.",
    weather: "Set the city above.",
    address: "Set the address above.",
    demo: "Run a PaperOffice API connection check."
  };

  ui.input.placeholder = placeholders[feature] || "Enter your request...";
  updateSendButton();
}

function resizeInput() {
  ui.input.style.height = "auto";
  ui.input.style.height = `${Math.min(ui.input.scrollHeight, 150)}px`;
}

function setAuthenticatedUser(user, savedChats = []) {
  currentUser = user || null;
  chats = currentUser && Array.isArray(savedChats) ? savedChats : [];
  activeChatId = null;

  $("accountName").textContent = currentUser?.name || "Guest";
  $("accountStatus").textContent = currentUser?.email || "Not signed in";
  $("accountAvatar").textContent =
    currentUser?.name?.charAt(0)?.toUpperCase() || "G";

  renderHistory();
  renderMessages();
}

function newChat() {
  activeChatId = null;

  pendingFiles.forEach(item => {
    if (item.preview) URL.revokeObjectURL(item.preview);
  });

  pendingFiles = [];
  renderAttachments();
  renderMessages();

  ui.input.value = "";
  resizeInput();
  updateSendButton();
  ui.input.focus();
}

function closeSidebar() {
  ui.sidebar.classList.remove("open");
}

$("newChat").addEventListener("click", newChat);
ui.send.addEventListener("click", sendMessage);

ui.input.addEventListener("input", () => {
  resizeInput();
  updateSendButton();
});

ui.input.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

$("attachButton").addEventListener("click", () => ui.fileInput.click());

ui.fileInput.addEventListener("change", event => {
  selectFiles(event.target.files);
  event.target.value = "";
});

ui.feature.addEventListener("change", updateFeatureOptions);

document.querySelectorAll(".suggestion").forEach(button => {
  button.addEventListener("click", () => {
    ui.feature.value = button.dataset.feature || "chat";
    updateFeatureOptions();

    ui.input.value = button.dataset.prompt || "";
    resizeInput();
    updateSendButton();
    ui.input.focus();
  });
});

$("upgradeButton").addEventListener("click", () => {
  openModal(
    "Support Veditalk",
    "The support option is a placeholder for now.",
    "Payments are not connected."
  );
});

$("accountButton").addEventListener("click", () => {
  openModal(
    "Guest mode",
    "You can use Veditalk without an account, but conversations are temporary.",
    "Appwrite authentication and cloud chat storage are not connected yet."
  );
});

$("loginButton").addEventListener("click", () => {
  openModal(
    "Login coming soon",
    "Appwrite authentication has not been connected yet.",
    "There is no fake login."
  );
});

$("clearHistory").addEventListener("click", () => {
  if (!currentUser) return;

  chats = [];
  activeChatId = null;

  renderHistory();
  renderMessages();
  showToast("Visible chat list cleared.");
});

$("themeButton").addEventListener("click", () => {
  document.body.classList.toggle("light");

  localStorage.setItem(
    "veditalk-theme",
    document.body.classList.contains("light") ? "light" : "dark"
  );
});

$("openSidebar").addEventListener("click", () => {
  ui.sidebar.classList.add("open");
});

$("closeSidebar").addEventListener("click", closeSidebar);
$("closeModal").addEventListener("click", closeModal);
$("modalOkay").addEventListener("click", closeModal);

ui.modal.addEventListener("click", event => {
  if (event.target === ui.modal) closeModal();
});

if (localStorage.getItem("veditalk-theme") === "light") {
  document.body.classList.add("light");
}

setAuthenticatedUser(null);
updateFeatureOptions();
updateSendButton();