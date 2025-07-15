const fs = require('fs');
const https = require('https');
const http = require('http');
const express = require('express');
const puppeteer = require('puppeteer');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const PDFDocument = require('pdfkit');
const stream = require('stream');
require('dotenv').config(); // Load Supabase env vars
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BUCKET_NAME = 'avatars';

function generatePDFBuffer(text, title = 'Extracted Page') {
  return new Promise((resolve) => {
    const doc = new PDFDocument();
    const bufferStream = new stream.PassThrough();
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    doc.pipe(bufferStream);
    doc.fontSize(16).text(title, { underline: true });
    doc.moveDown().fontSize(12).text(text, { align: 'left' });
    doc.end();
  });
}

const OpenAI = require("openai").default;

async function processWithOpenAIAssistant(url, description = '', vectorStoreId, assistantId) {
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  let file;
  if (url) {
    file = await openai.files.create({
      file: await fetch(url),
      purpose: "assistants",
    });
    await openai.vectorStores.files.create(vectorStoreId, {
      file_id: file.id,
    });

    while (true) {
      try {
        const vectorStoreFile = await openai.vectorStores.files.retrieve(vectorStoreId, file.id);
        if (vectorStoreFile.status === 'completed') break;
      } catch (e) {
        console.log("Polling error:", e.message);
        break;
      }
    }
  }

  console.log('Vector store File retrieved');
  const thread = await openai.beta.threads.create({
    messages: [
      {
        role: "user",
        content: `Create a detailed description using both:
1. The uploaded file(s) stored in the vector store (search and extract relevant information) — give this **higher priority**.
2. The following context: ${description} — use this to support or refine the content.

Prioritize information from the uploaded file(s), and only use the provided context if it's relevant or helpful in completing gaps.
Ensure the output is cohesive and comprehensive.. Do not use any newlines (\\n) in the response.`,
      },
    ],
    tool_resources: {
      file_search: {
        vector_store_ids: [vectorStoreId],
      },
    },
  });

  const run = await openai.beta.threads.runs.createAndPoll(thread.id, {
    assistant_id: assistantId,
  });

  const messages = await openai.beta.threads.messages.list(thread.id, {
    run_id: run.id,
  });

  const message = messages.data.pop();
  let jsonContent;
  if (message?.content[0]?.type === "text") {
    const { value } = message.content[0].text;
    const match = value.match(/```json\s*([\s\S]*?)```/);
    if (match) {
      const jsonString = match[1].replace(/【\d+:\d+†source】/g, '').trim();
      console.log('jsonString', jsonString);
      try {
        jsonContent = JSON.parse(jsonString);
      } catch (err) {
        console.error("Failed to parse JSON:", err.message);
      }
    }
  }

  await openai.beta.threads.delete(thread.id);
  await openai.files.delete(file.id);
  return jsonContent;
}

// 📥 POST API Route
app.post('/generateLearningPath', async (req, res) => {
  const { url, description = '' } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing URL' });

  const vectorStoreId = "vs_68304e767f888191b6f3d0618eee5694";
  const assistantId = "asst_fu80CfRMvwLgAYsP0poiWmb5";

  let browser;

  try {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    const html = await page.content();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article?.textContent) {
      return res.status(422).json({ error: 'Could not extract readable content' });
    }

    const filename = `extracted-${Date.now()}.pdf`;
    const pdfBuffer = await generatePDFBuffer(article.textContent, article.title);

    const { error: uploadError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(filename, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true
      });

    if (uploadError) {
      console.error('❌ Upload failed:', uploadError.message);
      return res.status(500).json({ error: 'Supabase upload failed' });
    }

    const { data: publicUrlData } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(filename);

    const response = {
      title: article.title,
      url: publicUrlData.publicUrl
    };

    const jsonContent = await processWithOpenAIAssistant(response.url, description || response.title, vectorStoreId, assistantId);

    res.json({
      ...response,
      result: jsonContent
    });

  } catch (err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

// 🔐 Server Setup
const PORT = process.env.PORT || 3003;

// HTTPS certs
const sslOptions = {
  key: fs.readFileSync('./selfsigned.key'), // or '/etc/ssl/private/selfsigned.key'
  cert: fs.readFileSync('./selfsigned.crt') // or '/etc/ssl/private/selfsigned.crt'
};

// Start HTTPS server
https.createServer(sslOptions, app).listen(PORT, () => {
  console.log(`🔐 HTTPS server running at https://localhost:${PORT}`);
});

// http.createServer(app).listen(PORT, () => {
//   console.log(`🌐 HTTP server running at http://localhost:${PORT}`);
// });
