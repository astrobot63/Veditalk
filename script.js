"use strict";

// ==========================================
// 1. CONFIGURATION
// ==========================================

const CONFIG = {
  PAPER_API_URL: "https://api.paperoffice.ai/latest",
  PAPER_API_KEY: "po_pk_910557515_de081807349357782b45fb50b60c5e0c484a42e7a1b6410c    ",

  TEXT_API_ENDPOINT: "https://veditalk-ai.qabunayla.workers.dev/",
  TEXT_API_KEY: "",

  APPWRITE_ENDPOINT: "https://sgp.cloud.appwrite.io/v1",
  APPWRITE_PROJECT_ID: "6ae9e1da00258a582138",

  DATABASE_ID: "6ae9e3b600286db871f6",
  CONVERSATIONS_TABLE_ID: "6ae9e3de002015ecb63f",
  MESSAGES_TABLE_ID: "6ae9e702003a2568a818",
  STORAGE_BUCKET_ID: "6aea8509000608d91e20",

  MAX_FILE_SIZE: 25 * 1024 * 1024,
  POLL_INTERVAL: 5000,
  MAX_POLL_ATTEMPTS: 60
};


// ==========================================
// 2. APPLICATION STATE
// ==========================================

let currentUser = null;
let currentConversationId = null;

let currentMode = "chat";
let selectedFile = null;

let isProcessing = false;
let pendingOtpUserId = null;
let pendingMode = null;

let appwriteReady = false;

let client = null;
let account = null;
let tablesDB = null;
let storage = null;

let guestMessages = [];


// ==========================================
// 3. DOM HELPERS
// ==========================================

const $ = id => document.getElementById(id);

const messagesContainer = $("messages");
const promptInput = $("promptInput");
const sendButton = $("sendButton");

const attachButton = $("attachButton");
const fileInput = $("fileInput");
const filePreview = $("filePreview");

const themeButton = $("themeButton");

const accountButton = $("accountButton");
const accountStatus = $("accountStatus");
const historyButton = $("historyButton");

const authOverlay = $("authOverlay");
const authChoice = $("authChoice");
const authForm = $("authForm");

const historyPanel = $("historyPanel");
const historyList = $("historyList");

const toastElement = $("toast");


// ==========================================
// 4. GENERAL HELPERS
// ==========================================

function showToast(message) {
  if (!toastElement) {
    console.log(message);
    return;
  }

  toastElement.textContent = message;
  toastElement.classList.add("show");

  clearTimeout(showToast.timeout);

  showToast.timeout = setTimeout(() => {
    toastElement.classList.remove("show");
  }, 3500);
}


function getErrorMessage(error) {
  return error?.message || "Something went wrong. Please try again.";
}


function setProcessing(value) {
  isProcessing = value;

  if (!sendButton) return;

  sendButton.disabled = value;

  const label = sendButton.querySelector("span");

  if (label) {
    label.textContent = value ? "..." : "↑";
  }

  const labels = {
    chat: "Send ",
    coding: "Run ",
    generate: "Generate ",
    analyze: "Analyze "
  };

  if (sendButton.firstChild?.nodeType === Node.TEXT_NODE) {
    sendButton.firstChild.textContent = value
      ? "Working "
      : labels[currentMode];
  }
}


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// ==========================================
// 5. APPWRITE INITIALIZATION
// ==========================================

function initializeAppwrite() {
  if (!window.Appwrite) {
    console.error("Appwrite SDK was not loaded.");
    showToast("Appwrite SDK failed to load.");
    return false;
  }

  try {
    client = new Appwrite.Client();

    client
      .setEndpoint(CONFIG.APPWRITE_ENDPOINT)
      .setProject(CONFIG.APPWRITE_PROJECT_ID);

    account = new Appwrite.Account(client);
    tablesDB = new Appwrite.TablesDB(client);
    storage = new Appwrite.Storage(client);

    appwriteReady = true;

    return true;
  } catch (error) {
    console.error("Appwrite initialization error:", error);
    showToast("Appwrite could not initialize.");
    return false;
  }
}


// ==========================================
// 6. PAPEROFFICE API
// ==========================================

function getPaperApiKey() {
  const key = CONFIG.PAPER_API_KEY.trim();

  if (
    !key ||
    key.includes("PASTE_YOUR_KEY")
  ) {
    throw new Error(
      "Add your PaperOffice publishable key in script.js."
    );
  }

  if (key.startsWith("po_sk_")) {
    throw new Error(
      "Secret PaperOffice keys must never be used in frontend code."
    );
  }

  if (!key.startsWith("po_pk_")) {
    throw new Error(
      "Invalid PaperOffice publishable key format."
    );
  }

  return key;
}


async function paperRequest(endpoint, options = {}) {
  const apiKey = getPaperApiKey();

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    ...options.headers
  };

  if (!(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(
    `${CONFIG.PAPER_API_URL}${endpoint}`,
    {
      ...options,
      headers
    }
  );

  const result = await response.json().catch(() => ({}));

  // DEBUGGING
  console.log("PaperOffice endpoint:", endpoint);
  console.log("PaperOffice HTTP status:", response.status);
  console.log("PaperOffice response:", result);

  if (!response.ok) {
    throw new Error(
      result.message ||
      result.error ||
      `PaperOffice error: HTTP ${response.status}`
    );
  }

  // Some APIs return errors inside HTTP 200 responses.
  if (
    result.success === false ||
    result.error ||
    result.job_status === "failed"
  ) {
    console.error("PaperOffice job error:", result);

    throw new Error(
      result.message ||
      result.error ||
      "PaperOffice rejected the job configuration."
    );
  }

  return result;
}

function getJobId(result) {
  return (
    result?.job_id ||
    result?.jobId ||
    result?.data?.job_id ||
    result?.data?.jobId ||
    result?.id ||
    result?.data?.id ||
    null
  );
}


async function pollPaperJob(jobId) {
  for (
    let attempt = 0;
    attempt < CONFIG.MAX_POLL_ATTEMPTS;
    attempt++
  ) {
    await sleep(CONFIG.POLL_INTERVAL);

    const result = await paperRequest(
      `/job/get/${encodeURIComponent(jobId)}`
    );

    const status = String(
      result?.job_status ||
      result?.data?.job_status ||
      result?.status ||
      result?.data?.status ||
      ""
    ).toLowerCase();

    if (status === "completed") {
      return (
        result.job_result ??
        result.data?.job_result ??
        result
      );
    }

    if (["failed", "error", "cancelled"].includes(status)) {
      throw new Error(
        result.message ||
        result.error ||
        "The PaperOffice job failed."
      );
    }
  }

  throw new Error(
    "The request timed out. Please try again."
  );
}


// ==========================================
// 7. RESPONSE EXTRACTION
// ==========================================

function extractText(value) {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map(extractText)
      .filter(Boolean)
      .join("\n");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const fields = [
    "text",
    "content",
    "transcription",
    "extracted_text",
    "markdown"
  ];

  for (const field of fields) {
    if (typeof value[field] === "string") {
      return value[field];
    }
  }

  for (const field of [
    "data",
    "result",
    "results",
    "output",
    "job_result"
  ]) {
    if (value[field] !== undefined) {
      const extracted = extractText(value[field]);

      if (extracted) return extracted;
    }
  }

  return "";
}


function extractImageUrls(value) {
  if (!value) return [];

  if (typeof value === "string") {
    return /^https?:\/\//i.test(value) ? [value] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(extractImageUrls);
  }

  if (typeof value !== "object") {
    return [];
  }

  const urls = [];

  for (const field of [
    "url",
    "image_url",
    "imageUrl",
    "output_url",
    "download_url"
  ]) {
    if (typeof value[field] === "string") {
      urls.push(value[field]);
    }
  }

  for (const field of [
    "data",
    "result",
    "results",
    "output",
    "images",
    "job_result"
  ]) {
    if (value[field] !== undefined) {
      urls.push(...extractImageUrls(value[field]));
    }
  }

  return [...new Set(urls)];
}


// ==========================================
// 8. MESSAGE DISPLAY
// ==========================================

function scrollToBottom() {
  window.scrollTo({
    top: document.body.scrollHeight,
    behavior: "smooth"
  });
}


function clearMessages() {
  if (messagesContainer) {
    messagesContainer.innerHTML = "";
  }
}


function addMessage(role, content) {
  if (!messagesContainer) return null;

  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;

  const label = document.createElement("div");
  label.className = "message-label";

  label.textContent =
    role === "user" ? "You" : "Veditalk";

  const messageContent = document.createElement("div");
  messageContent.className = "message-content";

  if (
    role === "assistant" &&
    typeof marked !== "undefined"
  ) {
    messageContent.innerHTML = marked.parse(
      String(content)
    );
  } else {
    messageContent.textContent = String(content);
  }

  wrapper.append(label, messageContent);
  messagesContainer.appendChild(wrapper);

  if (window.hljs) {
    wrapper.querySelectorAll("pre code").forEach(block => {
      window.hljs.highlightElement(block);
    });
  }

  scrollToBottom();

  return wrapper;
}


function addImageMessage(url) {
  if (!messagesContainer) return null;

  const wrapper = document.createElement("div");
  wrapper.className = "message assistant";

  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = "Veditalk";

  const image = document.createElement("img");

  image.className = "message-image";
  image.src = url;
  image.alt = "Generated image";
  image.loading = "lazy";

  image.onerror = () => {
    image.alt = "The generated image could not be loaded.";
  };

  wrapper.append(label, image);
  messagesContainer.appendChild(wrapper);

  scrollToBottom();

  return wrapper;
}


// ==========================================
// 9. APPWRITE PERMISSIONS
// ==========================================

function getRowPermissions(userId) {
  return [
    Appwrite.Permission.read(Appwrite.Role.user(userId)),
    Appwrite.Permission.update(Appwrite.Role.user(userId)),
    Appwrite.Permission.delete(Appwrite.Role.user(userId))
  ];
}


// ==========================================
// 10. CONVERSATION STORAGE
// ==========================================

function navigateToConversation(conversationId) {
  const url = `/v/${encodeURIComponent(conversationId)}`;

  if (window.location.pathname !== url) {
    history.pushState(
      { conversationId },
      "",
      url
    );
  }
}


function navigateToHome() {
  if (window.location.pathname !== "/") {
    history.pushState({}, "", "/");
  }
}


function getConversationIdFromUrl() {
  const match = window.location.pathname.match(/^\/v\/([^/]+)\/?$/);

  if (!match) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

async function createConversation(firstMessage) {
  if (!currentUser || !appwriteReady) {
    return null;
  }

  const now = new Date().toISOString();

  const conversation = await tablesDB.createRow({
    databaseId: CONFIG.DATABASE_ID,
    tableId: CONFIG.CONVERSATIONS_TABLE_ID,
    rowId: Appwrite.ID.unique(),

    data: {
      userId: currentUser.$id,
      title: String(firstMessage).slice(0, 70) || "New conversation",
      createdAt: now,
      updatedAt: now
    },

    permissions: getRowPermissions(currentUser.$id)
  });

  currentConversationId = conversation.$id;

  navigateToConversation(conversation.$id);

  return conversation;
}


async function saveMessage(role, content, attachments = []) {
  const message = {
    role,
    content: String(content),
    attachments,
    createdAt: new Date().toISOString()
  };

  guestMessages.push(message);

  if (!currentUser) return;

  if (!currentConversationId) {
    await createConversation(
      role === "user" ? content : "New conversation"
    );
  }

  const now = new Date().toISOString();

  await tablesDB.createRow({
    databaseId: CONFIG.DATABASE_ID,
    tableId: CONFIG.MESSAGES_TABLE_ID,
    rowId: Appwrite.ID.unique(),

    data: {
      conversationId: currentConversationId,
      userId: currentUser.$id,
      role,
      content: String(content).slice(0, 10000),
      createdAt: now
    },

    permissions: getRowPermissions(currentUser.$id)
  });

  await tablesDB.updateRow({
    databaseId: CONFIG.DATABASE_ID,
    tableId: CONFIG.CONVERSATIONS_TABLE_ID,
    rowId: currentConversationId,

    data: {
      updatedAt: now
    }
  });
}

async function uploadGeneratedImage(dataURI) {
  if (!currentUser || !storage) {
    throw new Error("Image storage requires a signed-in account.");
  }

  const response = await fetch(dataURI);
  const blob = await response.blob();

  const file = new File(
    [blob],
    `generated-${Date.now()}.jpg`,
    { type: blob.type || "image/jpeg" }
  );

  const uploaded = await storage.createFile({
    bucketId: CONFIG.STORAGE_BUCKET_ID,
    fileId: Appwrite.ID.unique(),
    file,
    permissions: getRowPermissions(currentUser.$id)
  });

  return uploaded.$id;
}


// ==========================================
// 11. CONVERSATION HISTORY
// ==========================================

async function loadHistory() {
  if (!currentUser || !appwriteReady) return;

  if (!historyList || !historyPanel) return;

  historyList.innerHTML = "<p>Loading conversations...</p>";
  historyPanel.classList.remove("hidden");

  try {
    const response = await tablesDB.listRows({
      databaseId: CONFIG.DATABASE_ID,
      tableId: CONFIG.CONVERSATIONS_TABLE_ID,

      queries: [
        Appwrite.Query.equal("userId", currentUser.$id),
        Appwrite.Query.orderDesc("updatedAt"),
        Appwrite.Query.limit(50)
      ]
    });

    historyList.innerHTML = "";

    if (!response.rows?.length) {
      historyList.textContent =
        "No saved conversations yet.";

      return;
    }

    for (const conversation of response.rows) {
      const button = document.createElement("button");

      button.className = "history-item";

      button.textContent =
        conversation.title || "Untitled conversation";

      button.addEventListener("click", () => {
        loadConversation(conversation.$id);
      });

      historyList.appendChild(button);
    }
  } catch (error) {
    console.error("History loading error:", error);

    historyList.textContent =
      "Unable to load conversations.";

    showToast(getErrorMessage(error));
  }
}




async function loadConversation(conversationId) {
  if (!currentUser || !appwriteReady) return;

  try {
    const response = await tablesDB.listRows({
      databaseId: CONFIG.DATABASE_ID,
      tableId: CONFIG.MESSAGES_TABLE_ID,

      queries: [
        Appwrite.Query.equal("conversationId", conversationId),
        Appwrite.Query.equal("userId", currentUser.$id),
        Appwrite.Query.orderAsc("createdAt"),
        Appwrite.Query.limit(100)
      ]
    });

    clearMessages();

    currentConversationId = conversationId;
    guestMessages = [];

    for (const message of response.rows || []) {
      guestMessages.push({
        role: message.role,
        content: message.content,
        createdAt: message.createdAt
      });

      if (message.role === "image") {
        try {
          const imageData = JSON.parse(message.content);

          if (
            imageData.type === "appwrite-image" &&
            imageData.fileId
          ) {
            const preview = storage.getFilePreview({
              bucketId: CONFIG.STORAGE_BUCKET_ID,
              fileId: imageData.fileId
            });

            const imageUrl = preview instanceof URL
              ? preview.href
              : String(preview);

            addImageMessage(imageUrl);
          } else {
            addImageMessage(message.content);
          }
        } catch (error) {
          console.error("Image loading error:", error);

          addMessage(
            "assistant",
            "This image could not be loaded."
          );
        }
      } else {
        addMessage(message.role, message.content);
      }
    }

    historyPanel?.classList.add("hidden");

    navigateToConversation(conversationId);

  } catch (error) {
    console.error("Conversation loading error:", error);
    showToast(getErrorMessage(error));
  }
}




function startNewConversation() {
  currentConversationId = null;
  guestMessages = [];

  navigateToHome();

  clearMessages();

  historyPanel?.classList.add("hidden");

  promptInput?.focus();
}


// ==========================================
// 12. IMAGE GENERATION
// ==========================================

async function generateImage(prompt) {
  const response = await fetch(
    CONFIG.TEXT_API_ENDPOINT,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        mode: "generate",
        prompt
      })
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      result.error || `Image generation failed: HTTP ${response.status}`
    );
  }

  if (!result.dataURI) {
    throw new Error(
      "The image model returned no image."
    );
  }

  return [result.dataURI];
}


// ==========================================
// 13. IMAGE AND PDF ANALYSIS
// ==========================================

async function analyzeFile(file, prompt = "") {
  const formData = new FormData();

  formData.append("file", file);

  if (prompt) {
    formData.append("prompt", prompt);
  }

  const request = await paperRequest(
    "/job/add/paperoffice_aiocr___generate",
    {
      method: "POST",
      body: formData
    }
  );

  const jobId = getJobId(request);

  if (!jobId) {
    const directText = extractText(request);

    if (directText) return directText;

    throw new Error(
      "PaperOffice did not return a job ID."
    );
  }

  const result = await pollPaperJob(jobId);
  const text = extractText(result);

  if (!text) {
    console.error("PaperOffice analysis result:", result);

    throw new Error(
      "No readable text was returned."
    );
  }

  return text;
}


// ==========================================
// 14. NORMAL CHAT AND CODING
// ==========================================

function buildChatPrompt(prompt, mode) {
  const instructions = mode === "coding"
    ? `You are Veditalk Coding Mode.

Help users generate, explain, debug, and rewrite code.

Rules:
- Provide complete code when requested.
- Use fenced code blocks for code.
- Explain important changes clearly.
- Never pretend code has been executed or tested.
- Ask for missing information when necessary.
- Preserve the user's existing architecture when editing projects.`
    : `You are Veditalk, a helpful general-purpose AI assistant.

Answer clearly, accurately, and naturally.
Use Markdown when it improves readability.
Be honest about uncertainty and limitations.`;

  const recentMessages = guestMessages
    .filter(message => message.role !== "image")
    .slice(-13);

  const history = recentMessages.filter(
    (message, index) => {
      const isLast = index === recentMessages.length - 1;

      return !(
        isLast &&
        message.role === "user" &&
        message.content === prompt
      );
    }
  );

  return {
    instructions,
    history,
    prompt
  };
}


async function generateTextResponse(request, mode) {
  if (!CONFIG.TEXT_API_ENDPOINT.trim()) {
    throw new Error(
      "The AI endpoint has not been configured."
    );
  }

  const messages = [
    {
      role: "system",
      content: request.instructions
    },

    ...request.history.map(message => ({
      role: message.role,
      content: message.content
    })),

    {
      role: "user",
      content: request.prompt
    }
  ];

  const headers = {
    "Content-Type": "application/json"
  };

  if (CONFIG.TEXT_API_KEY.trim()) {
    headers.Authorization =
      `Bearer ${CONFIG.TEXT_API_KEY.trim()}`;
  }

  const response = await fetch(
    CONFIG.TEXT_API_ENDPOINT,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages,
        mode
      })
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      result.error ||
      result.message ||
      `AI request failed: HTTP ${response.status}`
    );
  }

  const answer =
    result.response ??
    result.result?.response ??
    result.output ??
    result.content ??
    result.choices?.[0]?.message?.content;

  if (
    typeof answer !== "string" ||
    !answer.trim()
  ) {
    console.error("Raw Cloudflare AI response:", result);

    throw new Error(
      "The AI returned an unexpected response format."
    );
  }

  return answer.trim();
}


async function handleTextMode(prompt, mode) {
  const request = buildChatPrompt(prompt, mode);

  return generateTextResponse(request, mode);
}


// ==========================================
// 15. FILE HANDLING
// ==========================================

function validateFile(file) {
  if (!file) return false;

  if (file.size > CONFIG.MAX_FILE_SIZE) {
    showToast("Maximum file size is 25 MB.");
    return false;
  }

  const allowedTypes = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/tiff",
    "image/bmp",
    "application/pdf"
  ];

  if (!allowedTypes.includes(file.type)) {
    showToast(
      "Unsupported file type. Select an image or PDF."
    );

    return false;
  }

  return true;
}


function selectFile(file) {
  if (!validateFile(file)) return;

  selectedFile = file;

  filePreview?.classList.remove("hidden");

  const fileName = $("fileName");

  if (fileName) {
    fileName.textContent = file.name;
  }
}


function removeSelectedFile() {
  selectedFile = null;

  if (fileInput) {
    fileInput.value = "";
  }

  filePreview?.classList.add("hidden");
}


// ==========================================
// 16. MODE SWITCHING
// ==========================================

const MODE_SETTINGS = {
  chat: {
    hint: "Ask Veditalk anything.",
    placeholder: "Message Veditalk...",
    button: "Send "
  },

  coding: {
    hint: "Generate, explain, debug, or rewrite code.",
    placeholder: "Describe what you want to code...",
    button: "Run "
  },

  generate: {
    hint: "Describe your image in a prompt.",
    placeholder: "Describe the image you want to create...",
    button: "Generate "
  },

  analyze: {
    hint: "Attach an image or PDF to analyze.",
    placeholder: "Ask something about your file...",
    button: "Analyze "
  }
};


function setMode(mode) {
  if (!MODE_SETTINGS[mode]) return;
  if (mode === currentMode) return;
  if (isProcessing) return;

  const hasMessages =
    messagesContainer &&
    messagesContainer.children.length > 0;

  if (hasMessages) {
    pendingMode = mode;

    const currentName =
      document.querySelector(".mode-button.active")
        ?.textContent.trim() || currentMode;

    const nextName =
      document.querySelector(
        `[data-mode="${mode}"]`
      )?.textContent.trim() || mode;

    const switchMessage = $("modeSwitchMessage");
    const switchModal = $("modeSwitchModal");

    if (switchMessage && switchModal) {
      switchMessage.textContent =
        `Changing from ${currentName} to ${nextName} will reset the chat. Your signed-in messages have already been saved to history.`;

      switchModal.classList.remove("hidden");
    } else {
      applyMode(mode);
      startNewConversation();
    }

    return;
  }

  applyMode(mode);
}


function applyMode(mode) {
  if (!MODE_SETTINGS[mode]) return;

  currentMode = mode;

  document.querySelectorAll(".mode-button").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.mode === mode
    );
  });

  const settings = MODE_SETTINGS[mode];

  const modeHint = $("modeHint");

  if (modeHint) {
    modeHint.textContent = settings.hint;
  }

  if (promptInput) {
    promptInput.placeholder = settings.placeholder;
  }

  if (
    sendButton?.firstChild?.nodeType === Node.TEXT_NODE
  ) {
    sendButton.firstChild.textContent = settings.button;
  }

  if (attachButton) {
    attachButton.disabled = mode !== "analyze";
  }

  if (mode !== "analyze" && selectedFile) {
    removeSelectedFile();
  }
}


$("cancelModeSwitch")?.addEventListener("click", () => {
  pendingMode = null;

  $("modeSwitchModal")?.classList.add("hidden");
});


$("confirmModeSwitch")?.addEventListener(
  "click",
  () => {
    if (!pendingMode || isProcessing) return;

    const nextMode = pendingMode;

    clearMessages();

    guestMessages = [];
    currentConversationId = null;

    removeSelectedFile();

    applyMode(nextMode);

    $("modeSwitchModal")?.classList.add("hidden");

    pendingMode = null;
  }
);


// ==========================================
// 17. REQUEST HANDLING
// ==========================================

async function sendRequest() {
  if (isProcessing) return;

  const prompt = promptInput?.value.trim() || "";
  const file = selectedFile;

  if (!prompt && !file) {
    showToast(
      "Write a message or attach a file first."
    );

    return;
  }

  if (currentMode === "analyze" && !file) {
    showToast(
      "Attach an image or PDF first."
    );

    return;
  }

  if (currentMode === "generate" && file) {
    showToast(
      "Remove the attachment to generate an image."
    );

    return;
  }

  if (
    ["chat", "coding"].includes(currentMode) &&
    file
  ) {
    showToast(
      "File uploads are currently supported in Read Image / PDF mode."
    );

    return;
  }

  if (
    currentMode === "generate" &&
    !prompt
  ) {
    showToast(
      "Describe the image you want to generate."
    );

    return;
  }

  setProcessing(true);

  const modeAtStart = currentMode;

  const userText = prompt ||
    `Analyze file: ${file.name}`;

  const attachments = file
    ? [{
        name: file.name,
        type: file.type,
        size: file.size
      }]
    : [];

  addMessage("user", userText);

  try {
    await saveMessage(
      "user",
      userText,
      attachments
    );
  } catch (error) {
    console.error("User message saving error:", error);

    showToast(
      "Message sent, but it could not be saved to history."
    );
  }

  if (promptInput) {
    promptInput.value = "";
  }

  removeSelectedFile();

  let loadingMessage = null;

  try {
    // NORMAL CHAT
    if (modeAtStart === "chat") {
      loadingMessage = addMessage(
        "assistant",
        "Thinking..."
      );

      const result = await handleTextMode(
        prompt,
        "chat"
      );

      loadingMessage?.remove();
      loadingMessage = null;

      addMessage("assistant", result);

      try {
        await saveMessage("assistant", result);
      } catch (error) {
        console.error("Assistant saving error:", error);
        showToast("Reply received, but history could not be updated.");
      }
    }

    // CODING MODE
    else if (modeAtStart === "coding") {
      loadingMessage = addMessage(
        "assistant",
        "Working on your code..."
      );

      const result = await handleTextMode(
        prompt,
        "coding"
      );

      loadingMessage?.remove();
      loadingMessage = null;

      addMessage("assistant", result);

      try {
        await saveMessage("assistant", result);
      } catch (error) {
        console.error("Assistant saving error:", error);
        showToast("Reply received, but history could not be updated.");
      }
    }

    // IMAGE GENERATION
    else if (modeAtStart === "generate") {
      loadingMessage = addMessage(
        "assistant",
        "Creating your image..."
      );

      const images = await generateImage(prompt);

      loadingMessage?.remove();
      loadingMessage = null;

      for (const url of images) {
  addImageMessage(url);

  if (!currentUser) {
    continue;
  }

  try {
    const fileId = await uploadGeneratedImage(url);

    await saveMessage(
      "image",
      JSON.stringify({
        type: "appwrite-image",
        fileId
      })
    );
  } catch (error) {
    console.error("Image storage error:", error);
    showToast("Image generated, but could not be saved to history.");
  }
}
    }

    // IMAGE AND PDF ANALYSIS
    else if (modeAtStart === "analyze") {
      loadingMessage = addMessage(
        "assistant",
        "Reading your file..."
      );

      const result = await analyzeFile(
        file,
        prompt
      );

      loadingMessage?.remove();
      loadingMessage = null;

      addMessage("assistant", result);

      try {
        await saveMessage("assistant", result);
      } catch (error) {
        console.error("Analysis saving error:", error);
        showToast("Analysis completed, but history could not be updated.");
      }
    }

  } catch (error) {
    console.error("Request error:", error);

    loadingMessage?.remove();

    addMessage(
      "assistant",
      `I couldn't complete that request.\n\n${getErrorMessage(error)}`
    );
  } finally {
    setProcessing(false);
  }
}


// ==========================================
// 18. AUTHENTICATION INTERFACE
// ==========================================

function showAuth() {
  authOverlay?.classList.remove("hidden");

  showAuthChoices();
}


function hideAuth() {
  authOverlay?.classList.add("hidden");
}


function showAuthChoices() {
  authChoice?.classList.remove("hidden");
  authForm?.classList.add("hidden");

  const message = $("authMessage");

  if (message) {
    message.textContent = "";
  }
}


function showAuthForm(mode) {
  if (!authChoice || !authForm) return;

  authChoice.classList.add("hidden");
  authForm.classList.remove("hidden");

  const isRegister = mode === "register";
  const isOtp = mode === "otp";

  $("nameLabel")?.classList.toggle("hidden", !isRegister);
  $("authName")?.classList.toggle("hidden", !isRegister);

  $("passwordGroup")?.classList.toggle("hidden", isOtp);
  $("otpGroup")?.classList.toggle("hidden", !isOtp);

  $("authSubmit")?.classList.toggle("hidden", isOtp);
  $("otpSendButton")?.classList.toggle("hidden", isOtp);

  if ($("authName")) {
    $("authName").required = isRegister;
  }

  if ($("authPassword")) {
    $("authPassword").required = !isOtp;
  }

  if ($("authOtp")) {
    $("authOtp").required = isOtp;
  }

  const submitButton = $("authSubmit");

  if (submitButton) {
    submitButton.textContent =
      isRegister ? "Create account" : "Log in";
  }

  const message = $("authMessage");

  if (message) {
    message.textContent = "";
  }

  authForm.dataset.mode = mode;
}


// ==========================================
// 19. AUTHENTICATION ACTIONS
// ==========================================

async function registerUser(name, email, password) {
  await account.create({
    userId: Appwrite.ID.unique(),
    email,
    password,
    name
  });

  await account.createEmailPasswordSession({
    email,
    password
  });

  await refreshUser();
}


async function loginUser(email, password) {
  await account.createEmailPasswordSession({
    email,
    password
  });

  await refreshUser();
}


async function sendEmailCode(email) {
  pendingOtpUserId = Appwrite.ID.unique();

  await account.createEmailToken({
    userId: pendingOtpUserId,
    email
  });

  showAuthForm("otp");

  showToast(
    "Check your email for the verification code."
  );
}


async function verifyEmailCode(code) {
  if (!pendingOtpUserId) {
    throw new Error(
      "Request an email code first."
    );
  }

  await account.createSession({
    userId: pendingOtpUserId,
    secret: code
  });

  pendingOtpUserId = null;

  await refreshUser();
}


async function refreshUser() {
  if (!appwriteReady) return;

  try {
    currentUser = await account.get();

    if (accountStatus) {
      accountStatus.textContent =
        currentUser.name || currentUser.email;
    }

    if (accountButton) {
      accountButton.textContent = "Account";
    }

    historyButton?.classList.remove("hidden");

    hideAuth();
  } catch (error) {
    currentUser = null;

    if (accountStatus) {
      accountStatus.textContent = "Guest mode";
    }

    if (accountButton) {
      accountButton.textContent = "Log in";
    }

    historyButton?.classList.add("hidden");

    if (error?.code !== 401) {
      console.error("Account check error:", error);
    }
  }
}


async function logoutUser() {
  try {
    await account.deleteSession({
      sessionId: "current"
    });

    currentUser = null;
    currentConversationId = null;
    guestMessages = [];

    clearMessages();

    if (accountStatus) {
      accountStatus.textContent = "Guest mode";
    }

    if (accountButton) {
      accountButton.textContent = "Log in";
    }

    historyButton?.classList.add("hidden");
    historyPanel?.classList.add("hidden");

    showAuth();

    showToast(
      "You are now using guest mode."
    );
  } catch (error) {
    showToast(getErrorMessage(error));
  }
}


// ==========================================
// 20. AUTHENTICATION FORM
// ==========================================

async function submitAuthForm(event) {
  event.preventDefault();

  const mode = authForm?.dataset.mode;

  const name = $("authName")?.value.trim() || "";
  const email = $("authEmail")?.value.trim() || "";
  const password = $("authPassword")?.value || "";
  const code = $("authOtp")?.value.trim() || "";

  const message = $("authMessage");
  const submitButton = $("authSubmit");
  const otpButton = $("otpSendButton");

  if (message) {
    message.textContent = "Please wait...";
  }

  if (submitButton) {
    submitButton.disabled = true;
  }

  if (otpButton) {
    otpButton.disabled = true;
  }

  try {
    if (mode === "register") {
      if (!name || !email || !password) {
        throw new Error(
          "Complete all the fields."
        );
      }

      if (password.length < 8) {
        throw new Error(
          "Password must contain at least 8 characters."
        );
      }

      await registerUser(
        name,
        email,
        password
      );
    }

    else if (mode === "login") {
      if (!email || !password) {
        throw new Error(
          "Enter your email and password."
        );
      }

      await loginUser(email, password);
    }

    else if (mode === "otp") {
      if (!code) {
        throw new Error(
          "Enter the email verification code."
        );
      }

      await verifyEmailCode(code);
    }

  } catch (error) {
    if (message) {
      message.textContent = getErrorMessage(error);
    }
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
    }

    if (otpButton) {
      otpButton.disabled = false;
    }
  }
}


// ==========================================
// 21. THEME
// ==========================================

function loadTheme() {
  let savedTheme = "dark";

  try {
    savedTheme =
      localStorage.getItem("veditalk-theme") || "dark";
  } catch (error) {
    console.warn("Theme preference could not be loaded.");
  }

  const isLight = savedTheme === "light";

  document.body.classList.toggle("light", isLight);

  if (themeButton) {
    themeButton.textContent = isLight ? "☀" : "☼";
  }
}


function toggleTheme() {
  const isLight =
    document.body.classList.toggle("light");

  try {
    localStorage.setItem(
      "veditalk-theme",
      isLight ? "light" : "dark"
    );
  } catch (error) {
    console.warn("Theme preference could not be saved.");
  }

  if (themeButton) {
    themeButton.textContent = isLight ? "☀" : "☼";
  }
}


// ==========================================
// 22. EVENT LISTENERS
// ==========================================

// Mode buttons

document.querySelectorAll(".mode-button").forEach(button => {
  button.addEventListener("click", () => {
    setMode(button.dataset.mode);
  });
});


// Send message

sendButton?.addEventListener(
  "click",
  sendRequest
);


promptInput?.addEventListener("keydown", event => {
  if (
    event.key === "Enter" &&
    !event.shiftKey
  ) {
    event.preventDefault();
    sendRequest();
  }
});


// Attach file

attachButton?.addEventListener("click", () => {
  if (currentMode !== "analyze") {
    showToast(
      "Switch to Read Image / PDF mode to attach a file."
    );

    return;
  }

  fileInput?.click();
});


fileInput?.addEventListener("change", event => {
  const file = event.target.files?.[0];

  if (file) {
    selectFile(file);
  }
});


// Remove file

$("removeFileButton")?.addEventListener(
  "click",
  removeSelectedFile
);


// Theme

themeButton?.addEventListener(
  "click",
  toggleTheme
);


// Account button

accountButton?.addEventListener("click", () => {
  if (currentUser) {
    const shouldLogout = confirm(
      `Logged in as ${currentUser.email}.\n\nLog out?`
    );

    if (shouldLogout) {
      logoutUser();
    }
  } else {
    showAuth();
  }
});


// Guest mode

$("guestButton")?.addEventListener("click", () => {
  currentUser = null;

  if (accountStatus) {
    accountStatus.textContent = "Guest mode";
  }

  if (accountButton) {
    accountButton.textContent = "Log in";
  }

  historyButton?.classList.add("hidden");

  hideAuth();
});


// Login

$("showLoginButton")?.addEventListener("click", () => {
  showAuthForm("login");
});


// Registration

$("showSignupButton")?.addEventListener("click", () => {
  showAuthForm("register");
});


// Back

$("authBackButton")?.addEventListener("click", () => {
  showAuthChoices();
});


// Authentication form

authForm?.addEventListener(
  "submit",
  submitAuthForm
);


// Request OTP

$("otpSendButton")?.addEventListener(
  "click",
  async () => {
    const email = $("authEmail")?.value.trim() || "";

    if (!email) {
      showToast("Enter your email address first.");
      return;
    }

    const button = $("otpSendButton");

    button.disabled = true;

    try {
      await sendEmailCode(email);
    } catch (error) {
      const message = $("authMessage");

      if (message) {
        message.textContent = getErrorMessage(error);
      }
    } finally {
      button.disabled = false;
    }
  }
);


// History

historyButton?.addEventListener("click", () => {
  if (!historyPanel) return;

  if (historyPanel.classList.contains("hidden")) {
    loadHistory();
  } else {
    historyPanel.classList.add("hidden");
  }
});


// New conversation

$("newChatButton")?.addEventListener(
  "click",
  startNewConversation
);


// Close history

$("closeHistoryButton")?.addEventListener(
  "click",
  () => {
    historyPanel?.classList.add("hidden");
  }
);


// Close history when clicking outside

document.addEventListener("click", event => {
  if (
    historyPanel &&
    historyButton &&
    !historyPanel.classList.contains("hidden") &&
    !historyPanel.contains(event.target) &&
    !historyButton.contains(event.target)
  ) {
    historyPanel.classList.add("hidden");
  }
});


// ==========================================
// 23. STARTUP
// ==========================================

async function initializeVeditalk() {
  loadTheme();

  applyMode("chat");

  setProcessing(false);

  const initialized = initializeAppwrite();

  if (!initialized) {
    if (accountStatus) {
      accountStatus.textContent = "Guest mode";
    }

    if (accountButton) {
      accountButton.textContent = "Log in";
    }

    showAuth();

    return;
  }

  await refreshUser();

  if (!currentUser) {
    if (accountStatus) {
      accountStatus.textContent = "Guest mode";
    }

    if (accountButton) {
      accountButton.textContent = "Log in";
    }
  }
}


initializeVeditalk();
