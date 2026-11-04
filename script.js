
"use strict";

// ==========================================
// 1. CONFIGURATION
// ==========================================

const CONFIG = {
  PAPER_API_URL: "https://api.paperoffice.ai/latest",

  // PaperOffice publishable key.
  // Never place a po_sk_ secret key in frontend code.
  PAPER_API_KEY: "po_pk_910557515_de081807349357782b45fb50b60c5e0c484a42e7a1b6410c",

  APPWRITE_ENDPOINT: "https://sgp.cloud.appwrite.io/v1",
  APPWRITE_PROJECT_ID: "6ae9e1da00258a582138",

  DATABASE_ID: "6ae9e3b600286db871f6",
  CONVERSATIONS_TABLE_ID: "6ae9e3de002015ecb63f",
  MESSAGES_TABLE_ID: "6ae9e702003a2568a818",

  MAX_FILE_SIZE: 25 * 1024 * 1024,

  POLL_INTERVAL: 5000,
  MAX_POLL_ATTEMPTS: 60
};


// ==========================================
// 2. APPLICATION STATE
// ==========================================

let currentUser = null;
let currentConversationId = null;

let currentMode = "generate";
let selectedFile = null;

let isProcessing = false;
let pendingOtpUserId = null;

let appwriteReady = false;

let client = null;
let account = null;
let tablesDB = null;

let guestMessages = [];


// ==========================================
// 3. DOM ELEMENTS
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


function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, character => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };

    return entities[character];
  });
}


function getErrorMessage(error) {
  return error?.message || "Something went wrong. Please try again.";
}


function setProcessing(value) {
  isProcessing = value;

  if (sendButton) {
    sendButton.disabled = value;

    const label = sendButton.querySelector("span");

    if (label) {
      label.textContent = value ? "..." : "↑";
    }

    if (sendButton.firstChild?.nodeType === Node.TEXT_NODE) {
      sendButton.firstChild.textContent = value
        ? "Working "
        : currentMode === "generate"
          ? "Generate "
          : "Analyze ";
    }
  }
}


// ==========================================
// 5. APPWRITE INITIALIZATION
// ==========================================

function initializeAppwrite() {
  if (!window.Appwrite) {
    console.error("Appwrite SDK was not loaded.");
    showToast("Appwrite SDK failed to load. Check your internet connection.");
    return false;
  }

  try {
    client = new Appwrite.Client();

    client
      .setEndpoint(CONFIG.APPWRITE_ENDPOINT)
      .setProject(CONFIG.APPWRITE_PROJECT_ID);

    account = new Appwrite.Account(client);
    tablesDB = new Appwrite.TablesDB(client);

    appwriteReady = true;

    return true;
  } catch (error) {
    console.error("Appwrite initialization error:", error);
    showToast("Appwrite could not initialize.");
    return false;
  }
}


// ==========================================
// 6. PAPER OFFICE API
// ==========================================

function getPaperApiKey() {
  const key = CONFIG.PAPER_API_KEY.trim();

  if (!key || key.includes("PASTE_YOUR_KEY")) {
    throw new Error("Add your PaperOffice publishable key in script.js.");
  }

  if (key.startsWith("po_sk_")) {
    throw new Error(
      "Secret PaperOffice keys must not be used in frontend code."
    );
  }

  if (!key.startsWith("po_pk_")) {
    throw new Error("Invalid PaperOffice publishable key format.");
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

  if (!response.ok) {
    throw new Error(
      result.message ||
      result.error ||
      `PaperOffice error: HTTP ${response.status}`
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
    await new Promise(resolve => {
      setTimeout(resolve, CONFIG.POLL_INTERVAL);
    });

    const result = await paperRequest(
      `/job/status/${encodeURIComponent(jobId)}`
    );

    const status = String(
      result.status ||
      result.data?.status ||
      ""
    ).toLowerCase();

    if (
      ["completed", "complete", "success", "succeeded"].includes(status)
    ) {
      return result;
    }

    if (
      ["failed", "error", "cancelled"].includes(status)
    ) {
      throw new Error(
        result.message ||
        result.error ||
        "The PaperOffice job failed."
      );
    }
  }

  throw new Error("The request timed out. Please try again.");
}


// ==========================================
// 7. RESPONSE EXTRACTION
// ==========================================

function extractText(value) {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join("\n");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const fields = [
    "text",
    "content",
    "result",
    "output",
    "transcription",
    "extracted_text",
    "markdown"
  ];

  for (const field of fields) {
    if (typeof value[field] === "string") {
      return value[field];
    }
  }

  for (const field of ["data", "results"]) {
    if (value[field]) {
      const extracted = extractText(value[field]);

      if (extracted) return extracted;
    }
  }

  return "";
}


function extractImageUrls(value) {
  if (!value) return [];

  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) {
      return [value];
    }

    return [];
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
    "images"
  ]) {
    if (value[field]) {
      urls.push(...extractImageUrls(value[field]));
    }
  }

  return [...new Set(urls)];
}


// ==========================================
// 8. CHAT MESSAGES
// ==========================================

function scrollToBottom() {
  window.scrollTo({
    top: document.body.scrollHeight,
    behavior: "smooth"
  });
}


function clearMessages() {
  messagesContainer.innerHTML = "";
}


function addMessage(role, content) {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;

  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = role === "user" ? "You" : "Veditalk";

  const messageContent = document.createElement("div");
  messageContent.className = "message-content";
  messageContent.textContent = content;

  wrapper.append(label, messageContent);

  messagesContainer.appendChild(wrapper);

  scrollToBottom();

  return wrapper;
}


function addImageMessage(url) {
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
// 9. APPWRITE ROW PERMISSIONS
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

async function createConversation(firstMessage) {
  if (!currentUser || !appwriteReady) return null;

  const now = new Date().toISOString();

  const conversation = await tablesDB.createRow({
    databaseId: CONFIG.DATABASE_ID,
    tableId: CONFIG.CONVERSATIONS_TABLE_ID,
    rowId: Appwrite.ID.unique(),

    data: {
      userId: currentUser.$id,
      title: firstMessage.slice(0, 70) || "New conversation",
      createdAt: now,
      updatedAt: now
    },

    permissions: getRowPermissions(currentUser.$id)
  });

  currentConversationId = conversation.$id;

  return conversation;
}


async function saveMessage(role, content, attachments = []) {
  if (!currentUser) {
    guestMessages.push({
      role,
      content,
      attachments,
      createdAt: new Date().toISOString()
    });

    return;
  }

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
      createdAt: now,
      attachments: JSON.stringify(attachments).slice(0, 10000)
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


// ==========================================
// 11. LOAD CONVERSATIONS
// ==========================================

async function loadHistory() {
  if (!currentUser || !appwriteReady) return;

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

    if (!response.rows.length) {
      historyList.textContent = "No saved conversations yet.";
      return;
    }

    for (const conversation of response.rows) {
      const button = document.createElement("button");

      button.className = "history-item";
      button.textContent = conversation.title || "Untitled conversation";

      button.addEventListener("click", async () => {
        await loadConversation(conversation.$id);
      });

      historyList.appendChild(button);
    }
  } catch (error) {
    console.error("History loading error:", error);

    historyList.textContent = "Unable to load conversations.";
    showToast(getErrorMessage(error));
  }
}


async function loadConversation(conversationId) {
  if (!currentUser) return;

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

    for (const message of response.rows) {
      if (message.role === "image") {
        addImageMessage(message.content);
      } else {
        addMessage(message.role, message.content);
      }
    }

    historyPanel.classList.add("hidden");
  } catch (error) {
    showToast(getErrorMessage(error));
  }
}


function startNewConversation() {
  currentConversationId = null;
  guestMessages = [];

  clearMessages();

  historyPanel.classList.add("hidden");

  promptInput.focus();
}


// ==========================================
// 12. IMAGE GENERATION
// ==========================================

async function generateImage(prompt) {
  const request = await paperRequest(
    "/job/add/paperoffice_imagestudio___generate",
    {
      method: "POST",

      body: JSON.stringify({
        prompt,
        premium: true,
        width: 896,
        height: 1152,
        output_format: "url",
        number_of_images: 1,
        precompile_prompt: true,
        client_wait: false
      })
    }
  );

  const jobId = getJobId(request);

  if (!jobId) {
    const directImages = extractImageUrls(request);

    if (directImages.length) return directImages;

    throw new Error("PaperOffice did not return a job ID.");
  }

  const result = await pollPaperJob(jobId);
  const images = extractImageUrls(result);

  if (!images.length) {
    throw new Error("No image URL was returned.");
  }

  return images;
}


// ==========================================
// 13. FILE ANALYSIS
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

    throw new Error("PaperOffice did not return a job ID.");
  }

  const result = await pollPaperJob(jobId);
  const text = extractText(result);

  if (!text) {
    throw new Error("No readable text was returned.");
  }

  return text;
}


// ==========================================
// 14. FILE HANDLING
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
    showToast("Unsupported file type. Select an image or PDF.");
    return false;
  }

  return true;
}


function selectFile(file) {
  if (!validateFile(file)) return;

  selectedFile = file;

  filePreview.classList.remove("hidden");

  $("fileName").textContent = file.name;
}


function removeSelectedFile() {
  selectedFile = null;

  fileInput.value = "";

  filePreview.classList.add("hidden");
}


// ==========================================
// 15. MODE SWITCHING
// ==========================================

function setMode(mode) {
  currentMode = mode;

  document.querySelectorAll(".mode-button").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.mode === mode
    );
  });

  $("modeHint").textContent =
    mode === "generate"
      ? "Describe your image in a prompt."
      : "Attach an image or PDF to analyze.";

  promptInput.placeholder =
    mode === "generate"
      ? "Describe the image you want to create..."
      : "Ask something about your file...";

  const buttonText = sendButton.firstChild;

  if (buttonText?.nodeType === Node.TEXT_NODE) {
    buttonText.textContent =
      mode === "generate" ? "Generate " : "Analyze ";
  }
}


// ==========================================
// 16. SEND REQUEST
// ==========================================

async function sendRequest() {
  if (isProcessing) return;

  const prompt = promptInput.value.trim();

  if (!prompt && !selectedFile) {
    showToast("Write a prompt or attach a file first.");
    return;
  }

  if (currentMode === "analyze" && !selectedFile) {
    showToast("Attach an image or PDF first.");
    return;
  }

  if (currentMode === "generate" && selectedFile) {
    showToast("Switch to Analyze mode to use your attachment.");
    return;
  }

  setProcessing(true);

  const file = selectedFile;

  const userText = prompt ||
    (file ? `Analyze file: ${file.name}` : "");

  const attachments = file
    ? [{
        name: file.name,
        type: file.type,
        size: file.size
      }]
    : [];

  addMessage("user", userText);

  try {
    await saveMessage("user", userText, attachments);
  } catch (error) {
    console.error("Message saving error:", error);
    showToast("Your message could not be saved to history.");
  }

  promptInput.value = "";
  removeSelectedFile();

  let loadingMessage = null;

  try {
    if (currentMode === "generate") {
      loadingMessage = addMessage("assistant", "Creating your image...");

      const images = await generateImage(prompt);

      loadingMessage.remove();

      for (const url of images) {
        addImageMessage(url);

        try {
          await saveMessage("image", url);
        } catch (error) {
          console.error("Image history saving error:", error);
        }
      }
    } else {
      loadingMessage = addMessage("assistant", "Reading your file...");

      const result = await analyzeFile(file, prompt);

      loadingMessage.remove();

      addMessage("assistant", result);

      try {
        await saveMessage("assistant", result);
      } catch (error) {
        console.error("OCR history saving error:", error);
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
// 17. AUTHENTICATION INTERFACE
// ==========================================

function showAuth() {
  authOverlay.classList.remove("hidden");
  showAuthChoices();
}


function hideAuth() {
  authOverlay.classList.add("hidden");
}


function showAuthChoices() {
  authChoice.classList.remove("hidden");
  authForm.classList.add("hidden");

  $("authMessage").textContent = "";
}


function showAuthForm(mode) {
  authChoice.classList.add("hidden");
  authForm.classList.remove("hidden");

  const isRegister = mode === "register";
  const isOtp = mode === "otp";

  $("nameLabel").classList.toggle("hidden", !isRegister);
  $("authName").classList.toggle("hidden", !isRegister);

  $("passwordGroup").classList.toggle("hidden", isOtp);
  $("otpGroup").classList.toggle("hidden", !isOtp);

  $("authSubmit").classList.toggle("hidden", isOtp);
  $("otpSendButton").classList.toggle("hidden", isOtp);

  $("authName").required = isRegister;
  $("authPassword").required = !isOtp;
  $("authOtp").required = isOtp;

  $("authSubmit").textContent =
    isRegister ? "Create account" : "Log in";

  $("authMessage").textContent = "";

  authForm.dataset.mode = mode;
}


// ==========================================
// 18. AUTHENTICATION ACTIONS
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

  showToast("Check your email for the verification code.");
}


async function verifyEmailCode(code) {
  if (!pendingOtpUserId) {
    throw new Error("Request an email code first.");
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

    accountStatus.textContent =
      currentUser.name || currentUser.email;

    accountButton.textContent = "Account";
    historyButton.classList.remove("hidden");

    hideAuth();
  } catch {
    currentUser = null;

    accountStatus.textContent = "Guest mode";
    accountButton.textContent = "Log in";

    historyButton.classList.add("hidden");
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

    accountStatus.textContent = "Guest mode";
    accountButton.textContent = "Log in";

    historyButton.classList.add("hidden");
    historyPanel.classList.add("hidden");

    showAuth();

    showToast("You are now using guest mode.");
  } catch (error) {
    showToast(getErrorMessage(error));
  }
}


// ==========================================
// 19. AUTHENTICATION FORM
// ==========================================

async function submitAuthForm(event) {
  event.preventDefault();

  const mode = authForm.dataset.mode;

  const name = $("authName").value.trim();
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;
  const code = $("authOtp").value.trim();

  const message = $("authMessage");
  const submitButton = $("authSubmit");

  message.textContent = "Please wait...";

  submitButton.disabled = true;
  $("otpSendButton").disabled = true;

  try {
    if (mode === "register") {
      if (!name || !email || !password) {
        throw new Error("Complete all the fields.");
      }

      if (password.length < 8) {
        throw new Error("Password must contain at least 8 characters.");
      }

      await registerUser(name, email, password);
    }

    if (mode === "login") {
      if (!email || !password) {
        throw new Error("Enter your email and password.");
      }

      await loginUser(email, password);
    }

    if (mode === "otp") {
      if (!code) {
        throw new Error("Enter the email verification code.");
      }

      await verifyEmailCode(code);
    }
  } catch (error) {
    message.textContent = getErrorMessage(error);
  } finally {
    submitButton.disabled = false;
    $("otpSendButton").disabled = false;
  }
}


// ==========================================
// 20. THEME
// ==========================================

function loadTheme() {
  const savedTheme = localStorage.getItem("veditalk-theme");

  const isLight = savedTheme === "light";

  document.body.classList.toggle("light", isLight);

  themeButton.textContent = isLight ? "☀" : "☼";
}


function toggleTheme() {
  const isLight = document.body.classList.toggle("light");

  localStorage.setItem(
    "veditalk-theme",
    isLight ? "light" : "dark"
  );

  themeButton.textContent = isLight ? "☀" : "☼";
}


// ==========================================
// 21. EVENT LISTENERS
// ==========================================

// Mode buttons

document.querySelectorAll(".mode-button").forEach(button => {
  button.addEventListener("click", () => {
    setMode(button.dataset.mode);
  });
});


// Send

sendButton.addEventListener("click", sendRequest);

promptInput.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendRequest();
  }
});


// Attach file

attachButton.addEventListener("click", () => {
  fileInput.click();
});

fileInput.addEventListener("change", event => {
  const file = event.target.files[0];

  if (file) {
    selectFile(file);
  }
});


// Remove file

$("removeFileButton").addEventListener(
  "click",
  removeSelectedFile
);


// Theme

themeButton.addEventListener("click", toggleTheme);


// Account button

accountButton.addEventListener("click", () => {
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

$("guestButton").addEventListener("click", () => {
  currentUser = null;

  accountStatus.textContent = "Guest mode";
  accountButton.textContent = "Log in";

  historyButton.classList.add("hidden");

  hideAuth();
});


// Login

$("showLoginButton").addEventListener("click", () => {
  showAuthForm("login");
});


// Registration

$("showSignupButton").addEventListener("click", () => {
  showAuthForm("register");
});


// Back

$("authBackButton").addEventListener("click", () => {
  showAuthChoices();
});


// Submit login / registration / OTP

authForm.addEventListener("submit", submitAuthForm);


// Request OTP

$("otpSendButton").addEventListener("click", async () => {
  const email = $("authEmail").value.trim();

  if (!email) {
    showToast("Enter your email address first.");
    return;
  }

  try {
    $("otpSendButton").disabled = true;

    await sendEmailCode(email);
  } catch (error) {
    $("authMessage").textContent = getErrorMessage(error);
  } finally {
    $("otpSendButton").disabled = false;
  }
});


// History

historyButton.addEventListener("click", () => {
  if (historyPanel.classList.contains("hidden")) {
    loadHistory();
  } else {
    historyPanel.classList.add("hidden");
  }
});


// New conversation

$("newChatButton").addEventListener("click", startNewConversation);


// Close history

$("closeHistoryButton").addEventListener("click", () => {
  historyPanel.classList.add("hidden");
});


// Close history when clicking outside

document.addEventListener("click", event => {
  if (
    historyPanel &&
    !historyPanel.classList.contains("hidden") &&
    !historyPanel.contains(event.target) &&
    !historyButton.contains(event.target)
  ) {
    historyPanel.classList.add("hidden");
  }
});


// ==========================================
// 22. STARTUP
// ==========================================

async function initializeVeditalk() {
  loadTheme();

  setMode("generate");

  setProcessing(false);

  const initialized = initializeAppwrite();

  if (!initialized) {
    accountStatus.textContent = "Guest mode";
    accountButton.textContent = "Log in";

    return;
  }

  await refreshUser();

  if (!currentUser) {
    accountStatus.textContent = "Guest mode";
    accountButton.textContent = "Log in";
  }
}

initializeVeditalk();
