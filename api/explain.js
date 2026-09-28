import fs from 'fs';
import https from 'https';

const ca = [
  fs.readFileSync('./certs/Russian_Trusted_Root_CA.cer'),
  fs.readFileSync('./certs/Russian_Trusted_Sub_CA.cer')
];

const httpsAgent = new https.Agent({ ca });

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { grade, subject, topic, style } = req.body || {};

    if (!grade || !subject || !topic || !style) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const authKey = process.env.GIGACHAT_AUTH_KEY;

    if (!authKey) {
      return res.status(500).json({
        error: 'GIGACHAT_AUTH_KEY is not configured'
      });
    }

    const styleMap = {
      simple: 'очень простым языком, как для друга',
      example: 'через знакомый жизненный пример',
      visual: 'через простую текстовую схему и объяснение',
      game: 'как маленькую игру с коротким заданием',
      teacher: 'как хороший учитель: подробно и по шагам',
      fun: 'с лёгким уместным юмором, не теряя смысла'
    };

    const prompt = `Ты — доброжелательный AI-помощник для школьника.

Класс: ${grade}
Предмет: ${subject}
Вопрос ребёнка: ${topic}
Способ объяснения: ${styleMap[style] || styleMap.simple}

Объясни именно эту тему на уровне указанного класса.
Не перегружай терминами.
Если используешь термин, сразу объясни его простыми словами.
Не придумывай факты.

В конце дай одну короткую фразу для запоминания и один вопрос с тремя вариантами ответа для проверки понимания.

Верни только JSON:
{
  "title": "короткий заголовок",
  "explanation": "понятное объяснение",
  "summary": "одна короткая фраза для запоминания",
  "quizQuestion": "вопрос",
  "quizOptions": ["вариант 1", "вариант 2", "вариант 3"],
  "quizCorrectIndex": 0
}`;

    const tokenResponse = await fetch(
      'https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'RqUID': crypto.randomUUID(),
          'Authorization': `Basic ${authKey}`
        },
        body: 'scope=GIGACHAT_API_PERS',
        agent: httpsAgent
      }
    );

    if (!tokenResponse.ok) {
      const detail = await tokenResponse.text();

      return res.status(502).json({
        error: 'GigaChat authorization failed',
        detail
      });
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    const response = await fetch(
      'https://api.giga.chat/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          model: 'GigaChat-3-Ultra',
          messages: [
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.3
        }),
        agent: httpsAgent
      }
    );

    if (!response.ok) {
      const detail = await response.text();

      return res.status(502).json({
        error: 'GigaChat request failed',
        detail
      });
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;

    if (!text) {
      return res.status(502).json({
        error: 'Empty GigaChat response'
      });
    }

    const cleanText = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    return res.status(200).json(JSON.parse(cleanText));

  } catch (error) {
    console.error('GigaChat error:', error);

    return res.status(500).json({
      error: 'Server error',
      detail: error?.message || 'Unknown error'
    });
  }
}
