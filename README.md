# 🚀 Quick Start Guide: How to Run the Bot

Follow these simple step-by-step instructions to set up, configure, and run this chatbot application on your local machine.

---

## 📋 Prerequisites

Before running the application, make sure you have the following installed:

1. **Node.js** (v18 or higher recommended)
2. **MySQL Database Server** (running locally or remotely)
3. **Ollama Server** (for local LLM and embedding models)
   * Download and install Ollama from [ollama.com](https://ollama.com).
   * Open your terminal and pull the required models:
     ```bash
     ollama pull qwen2.5:7b-instruct
     ollama pull bge-m3
     ```

---

## 🛠️ Step 1: Install Dependencies

1. Open your terminal in the project's root folder (`Rag-interview`).
2. Run the following command to install the required Node.js packages:
   ```bash
   npm install
   ```

---

## ⚙️ Step 2: Configure Environment Variables

Create a new file named **`.env`** in the root directory of the project and add your configurations. Here is a template you can copy and paste:

```env
# Server configuration
PORT=4000

# MySQL Database configuration
DB_HOST=127.0.0.1
DB_USER=root
DB_PASS=your_mysql_password
DB_NAME=workflow-Ai

# Ollama AI Configuration
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_CHAT_MODEL=qwen2.5:7b-instruct
OLLAMA_EMBED_MODEL=bge-m3
```

> [!NOTE]
> The database specified in `DB_NAME` (default: `workflow-Ai`) will be **created automatically** by the app on boot if it does not exist yet.

---

## 🧪 Step 3: Verify Environment Connection

Run the environment check script to make sure the `.env` configurations are loaded successfully:

```bash
node check-env.mjs
```

---

## 🏃 Step 4: Run the Application

Since the primary server entry point file is named `serverButton.js`, execute the server directly using:

```bash
node serverButton.js
```

Upon a successful startup, you will see logs similar to this:
```text
[DB] Connected to workflow-Ai
[DB] Schema verified / migrated.
[DB] Created default tenant ID 1
[ AI] up on :4000 | Model: qwen2.5:7b-instruct | Bot: iBot
[Security] REQUIRE_CLIENT_KEY=false
[Status] Modular architecture fully loaded.
```

---

## 📡 Step 5: Test the Application

### Option A: Run Simulation Tests (Recommended)
You can run automated mock chat flows (which seed a test tenant, simulate form filling, and query the graph) by running:
```bash
node test_nodes.js
```

### Option B: Send HTTP Requests
The server exposes a `/chat` API endpoint on port `4000`. You can send a `POST` request to `http://localhost:4000/chat` using Postman, Curl, or standard fetch scripts:

**Curl Example:**
```bash
curl -X POST http://localhost:4000/chat \
  -H "Content-Type: application/json" \
  -d '{"query": "hello", "user_key": "test_user_123"}'
```
