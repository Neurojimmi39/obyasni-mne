export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { grade, subject, topic, style } = req.body || {};
    if (!grade || !subject || !topic || !style) return res.status(400).json({ error: 'Missing fields' });

    const styleMap = {
      simple: 'очень простым языком, как для друга',
      example: 'через знакомый жизненный пример',
      visual: 'через простую текстовую схему и объяснение',
      game: 'как маленькую игру с коротким заданием',
      teacher: 'как хороший учитель: подробно и по шагам',
      fun: 'с лёгким уместным юмором, не теряя смысла'
    };

    const prompt = `Ты — доброжелательный AI-помощник для школьника.\nКласс: ${grade}\nПредмет: ${subject}\nВопрос ребёнка: ${topic}\nСпособ объяснения: ${styleMap[style] || styleMap.simple}\n\nОбъясни именно эту тему на уровне указанного класса. Не перегружай терминами. Если используешь термин, сразу объясни его простыми словами. Не придумывай факты. В конце дай одну короткую фразу для запоминания и один вопрос с тремя вариантами ответа для проверки понимания. Верни только JSON с полями: title, explanation, summary, quizQuestion, quizOptions (массив из 3 строк), quizCorrectIndex (0, 1 или 2).`;

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
        input: prompt,
        text: { format: { type: 'json_object' } }
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      return res.status(502).json({ error: 'OpenAI request failed', detail });
    }

    const data = await response.json();
    const text = data.output_text || data.output?.flatMap(x => x.content || []).find(x => x.type === 'output_text')?.text;
    if (!text) return res.status(502).json({ error: 'Empty AI response' });
    return res.status(200).json(JSON.parse(text));
  } catch (error) {
    return res.status(500).json({ error: 'Server error' });
  }
}
