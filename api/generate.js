export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt, imageBase64, mimeType } = req.body;
  const token = process.env.REPLICATE_API_TOKEN;

  if (!token) return res.status(500).json({ error: 'Missing API token' });

  try {
    const response = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait=60'
      },
      body: JSON.stringify({
        input: {
          prompt: prompt,
          image: `data:${mimeType};base64,${imageBase64}`,
          prompt_strength: 0.82,
          num_inference_steps: 35,
          guidance_scale: 3.5
        }
      })
    });

    const prediction = await response.json();

    if (!response.ok) return res.status(response.status).json({ error: prediction.detail || 'Replicate error' });

    if (prediction.status === 'succeeded') {
      return res.status(200).json({ imageUrl: prediction.output[0] || prediction.output });
    }

    // Polling
    const id = prediction.id;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const poll = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await poll.json();
      if (data.status === 'succeeded') return res.status(200).json({ imageUrl: data.output[0] || data.output });
      if (data.status === 'failed') return res.status(500).json({ error: data.error || 'Generation failed' });
    }

    return res.status(504).json({ error: 'Timeout' });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
