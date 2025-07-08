const express = require('express');
const puppeteer = require('puppeteer');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');

const app = express();
app.use(express.json());

app.get('/extract', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'Missing URL query param' });

    let browser;
    try {
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
        const page = await browser.newPage();

        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/117.0.0.0 Safari/537.36");
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        const html = await page.content();
        const dom = new JSDOM(html, { url });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (!article || !article.textContent) {
            return res.status(422).json({ error: 'Unable to extract content' });
        }

        res.json({
            title: article.title,
            text: article.textContent.trim()
        });

    } catch (err) {
        console.error("Error:", err.message);
        res.status(500).json({ error: 'Internal server error', detail: err.message });
    } finally {
        if (browser) await browser.close();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Text extractor running on http://localhost:${PORT}/extract?url=https://example.com`);
});
