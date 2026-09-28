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

function httpsRequest(url, options = {}, body = '') {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      ...options,
      agent: httpsAgent
    }, (response) => {
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
    });

    request.on('error', reject);

    if (body) {
      request.write(body);
    }

    request.end();
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  try {
    const {
      grade,
      subject,
      topic,
      style
    } = req.body || {};

    if (!grade || !subject || !topic || !style) {
      return res.status(400).json({
        error: 'Missing fields'
      });
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

    // ==========================================
    // 1. Получаем токен GigaChat
    // ==========================================

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

    // ==========================================
    // 2. Получаем текстовое объяснение
    // ==========================================

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
      JSON.stringify({
        model: 'GigaChat-3-Ultra',
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3
      })
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

    const result = JSON.parse(cleanText);

    // ==========================================
    // 3. Если выбрана "С картинкой",
    //    отдельно просим GigaChat создать изображение
    // ==========================================

    if (style === 'visual') {
      try {
        const imagePrompt = `Нарисуй наглядную образовательную иллюстрацию для школьника ${grade} класса.

Предмет: ${subject}
Тема: ${topic}

Картинка должна помогать ребёнку понять эту тему, а не просто украшать объяснение.

Требования:
- понятная школьнику;
- наглядная;
- простая композиция;
- показывает главную идею темы;
- без лишних деталей;
- без декоративного текста;
- без надписей;
- без букв;
- без цифр;
- без подписей на изображении.`;

        const imageResponse = await httpsRequest(
          'https://api.giga.chat/v1/chat/completions',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
              'Authorization': `Bearer ${accessToken}`
            }
          },
          JSON.stringify({
            model: 'GigaChat-2-Pro',
            messages: [
              {
                role: 'user',
                content: imagePrompt
              }
            ],
            function_call: 'auto'
          })
        );

        if (!imageResponse.ok) {
          const detail = await imageResponse.text();

          console.error(
            'GigaChat image request failed:',
            imageResponse.status,
            detail
          );
        } else {
          const imageData = await imageResponse.json();

          const imageText =
            imageData?.choices?.[0]?.message?.content || '';

          console.log('GigaChat image response:', imageText);

          // Ищем UUID картинки в ответе:
          // <img src="UUID" .../>

          const imageMatch = imageText.match(
            /<img\s+src=["']([^"']+)["']/i
          );

          if (imageMatch?.[1]) {
            const imageFileId = imageMatch[1];

            // ==========================================
            // 4. Скачиваем созданную картинку
            // ==========================================

            const imageFileResponse = await httpsRequest(
              `https://api.giga.chat/v1/files/${imageFileId}/content`,
              {
                method: 'GET',
                headers: {
                  'Accept': 'application/jpg',
                  'Authorization': `Bearer ${accessToken}`
                }
              }
            );

            if (!imageFileResponse.ok) {
              const detail = await imageFileResponse.text();

              console.error(
                'GigaChat image download failed:',
                imageFileResponse.status,
                detail
              );
            } else {
              const imageBuffer =
                await imageFileResponse.buffer();

              result.image =
                `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;

              console.log('Image successfully generated');
            }
          } else {
            console.error(
              'Image UUID was not found in GigaChat response'
            );
          }
        }

      } catch (imageError) {
        // Ошибка картинки не ломает основное объяснение
        console.error(
          'GigaChat image generation error:',
          imageError
        );
      }
    }

    // ==========================================
    // 5. Возвращаем результат сайту
    // ==========================================

    return res.status(200).json(result);

  } catch (error) {
    console.error('GigaChat error:', error);

    return res.status(500).json({
      error: 'Server error',
      detail: error?.message || 'Unknown error'
    });
  }
}
