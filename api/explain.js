export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { grade, subject, topic, style } = req.body || {};

    if (!grade || !subject || !topic || !style) {
      return res.status(400).json({
        error: "Не хватает данных для объяснения"
      });
    }

    const authKey = process.env.GIGACHAT_AUTH_KEY;

    if (!authKey) {
      return res.status(500).json({
        error: "GigaChat key is not configured"
      });
    }

    // Получаем временный access token
    const tokenResponse = await fetch(
      "https://ngw.devices.sberbank.ru:9443/api/v2/oauth",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
          "RqUID": crypto.randomUUID(),
          "Authorization": `Basic ${authKey}`
        },
        body: "scope=GIGACHAT_API_PERS"
      }
    );

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();

      return res.status(500).json({
        error: "Не удалось получить токен GigaChat",
        details: errorText
      });
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    const styleNames = {
      simple: "очень простым языком, как для друга",
      example: "через понятный бытовой пример",
      visual: "через простую словесную схему или образ",
      game: "как небольшую игру или мини-задание",
      teacher: "подробно и последовательно, как хороший учитель",
      fun: "с лёгким юмором, но без потери смысла"
    };

    const prompt = `
Ты — доброжелательный помощник школьника.

Класс: ${grade}
Предмет: ${subject}
Тема или вопрос ребёнка: ${topic}

Ребёнок попросил объяснить тему ${styleNames[style] || "понятно и простыми словами"}.

Твоя задача:
1. Объяснить тему на уровне указанного класса.
2. Не перегружать ответ сложными терминами.
3. Если используешь термин — сразу объяснить его.
4. Дать один понятный пример.
5. В конце сформулировать главное в одной короткой фразе.
6. Составить один небольшой вопрос для проверки понимания.
7. Дать 3 варианта ответа.
8. Указать номер правильного варианта: 0, 1 или 2.

Верни ТОЛЬКО корректный JSON такого вида:

{
  "title": "короткий заголовок",
  "explanation": "понятное объяснение",
  "summary": "главная мысль одной фразой",
  "quizQuestion": "вопрос",
  "quizOptions": [
    "вариант 1",
    "вариант 2",
    "вариант 3"
  ],
  "quizCorrectIndex": 0
}
`;

    const gigaResponse = await fetch(
      "https://api.giga.chat/v2/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Authorization": `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          model: "GigaChat-3-Ultra",
          messages: [
            {
              role: "user",
              content: prompt
            }
          ],
          temperature: 0.4
        })
      }
    );

    if (!gigaResponse.ok) {
      const errorText = await gigaResponse.text();

      return res.status(500).json({
        error: "Ошибка GigaChat",
        details: errorText
      });
    }

    const gigaData = await gigaResponse.json();

    const content =
      gigaData?.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("GigaChat вернул пустой ответ");
    }

    const cleaned = content
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const result = JSON.parse(cleaned);

    return res.status(200).json(result);

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Не удалось получить объяснение",
      details: error.message
    });
  }
}
