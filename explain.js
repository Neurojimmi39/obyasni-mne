import fs from 'fs';
import path from 'path';
import https from 'https';
import { randomUUID } from 'crypto';

const certDir = path.join(process.cwd(), 'certs');

const ca = [
  fs.readFileSync(path.join(certDir, 'Russian_Trusted_Root_CA.cer')),
  fs.readFileSync(path.join(certDir, 'Russian_Trusted_Sub_CA.cer'))
];

const httpsAgent = new https.Agent({ ca });

function httpsRequest(url, options = {}, body = '', binary = false) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        ...options,
        agent: httpsAgent
      },
      (response) => {
        const chunks = [];

        response.on('data', chunk => {
          chunks.push(chunk);
        });

        response.on('end', () => {
          const buffer = Buffer.concat(chunks);

          resolve({
            status: response.statusCode,
            ok: response.statusCode >= 200 && response.statusCode < 300,
            text: async () => buffer.toString('utf8'),
            json: async () => JSON.parse(buffer.toString('utf8')),
            buffer: async () => buffer
          });
        });
      }
    );

    request.on('error', reject);

    if (body) {
      request.write(body);
    }

    request.end();
  });
}

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
      visual: 'через понятную наглядную иллюстрацию и объяснение',
      game: 'как маленькую игру с коротким заданием',
      teacher: 'как хороший учитель: подробно и по шагам',
      fun: 'с лёгким уместным юмором, не теряя смысла'
    };

    const wantsImage = style === 'visual';

    const prompt = `Ты — доброжелательный AI-помощник для школьника.

Класс: ${grade}
Предмет: ${subject}
Вопрос ребёнка: ${topic}
Способ объяснения: ${styleMap[style] || styleMap.simple}

Объясни именно эту тему на уровне указанного класса.
Не перегружай терминами.
Если используешь термин, сразу объясни его простыми словами.
Не придумывай факты.

${wantsImage
  ? 'Создай наглядную образовательную иллюстрацию к этой теме. Картинка должна помогать ребёнку понять именно эту тему, а не быть просто декоративной.'
  : ''
}

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

    // Получаем токен GigaChat
    const tokenResponse = await httpsRequest(
      'https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'RqUID': randomUUID(),
          'Authorization': `Basic ${authKey}`
        }
      },
      'scope=GIGACHAT_API_PERS'
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

    // Запрос к GigaChat
    const gigaPayload = {
      model: 'GigaChat-3-Ultra',
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.3
    };

    // Для режима "С картинкой" разрешаем встроенную функцию text2image
    if (wantsImage) {
      gigaPayload.function_call = 'auto';
      gigaPayload.functions = [
        {
          name: 'text2image'
        }
      ];
    }

    const response = await httpsRequest(
      'https://api.giga.chat/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        }
      },
      JSON.stringify(gigaPayload)
    );

    if (!response.ok) {
      const detail = await response.text();

      return res.status(502).json({
        error: 'GigaChat request failed',
        detail
      });
    }

    const data = await response.json();
    const message = data?.choices?.[0]?.message;
    const text = message?.content;

    if (!text) {
      return res.status(502).json({
        error: 'Empty GigaChat response'
      });
    }

    // Ищем ID созданного изображения
    const imageMatch = text.match(
      /<img\s+src=["']([^"']+)["']/i
    );

    let imageData = null;

    if (imageMatch && imageMatch[1]) {
      const imageId = imageMatch[1];

      const imageResponse = await httpsRequest(
        `https://api.giga.chat/v1/files/${imageId}/content`,
        {
          method: 'GET',
          headers: {
            'Accept': 'image/jpeg',
            'Authorization': `Bearer ${accessToken}`
          }
        }
      );

      if (imageResponse.ok) {
        const imageBuffer = await imageResponse.buffer();

        imageData =
          `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;
      }
    }

    // Убираем служебный тег картинки перед разбором JSON
    const cleanText = text
      .replace(/<img\s+src=["'][^"']+["'][^>]*\/?>/gi, '')
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let result;

    try {
      result = JSON.parse(cleanText);
    } catch {
      result = {
        title: topic,
        explanation: cleanText,
        summary: 'Главное — понять смысл, а не просто запомнить.',
        quizQuestion: 'Что главное в этой теме?',
        quizOptions: [
          'Понять основную идею',
          'Запомнить все слова',
          'Запомнить одну цифру'
        ],
        quizCorrectIndex: 0
      };
    }

    return res.status(200).json({
      ...result,
      image: imageData
    });

  } catch (error) {
    console.error('GigaChat error:', error);

    return res.status(500).json({
      error: 'Server error',
      detail: error?.message || 'Unknown error'
    });
  }
}
