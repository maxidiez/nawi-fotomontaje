import { deflateSync } from 'zlib';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt, imageBase64, mimeType } = req.body;
  const token = process.env.REPLICATE_API_TOKEN;

  if (!token) return res.status(500).json({ error: 'Missing API token' });

  try {
    const maskBase64 = generateWhitePNG(1024, 1024);

    const response = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-fill-pro/predictions', {
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
          mask: `data:image/png;base64,${maskBase64}`,
          num_inference_steps: 50,
          guidance_scale: 30
        }
      })
    });

    const prediction = await response.json();

    if (!response.ok) return res.status(response.status).json({ error: prediction.detail || 'Replicate error' });

    if (prediction.status === 'succeeded') {
      console.log('[generate] output (sync):', JSON.stringify(prediction.output));
      const url = extractUrl(prediction.output);
      return res.status(200).json(await urlToBase64Response(url));
    }

    // Polling
    const id = prediction.id;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const poll = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await poll.json();
      if (data.status === 'succeeded') {
        console.log('[generate] output (poll #' + (i + 1) + '):', JSON.stringify(data.output));
        const url = extractUrl(data.output);
        return res.status(200).json(await urlToBase64Response(url));
      }
      if (data.status === 'failed') return res.status(500).json({ error: data.error || 'Generation failed' });
    }

    return res.status(504).json({ error: 'Timeout' });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

// Genera un PNG blanco sólido de width×height sin dependencias externas
function generateWhitePNG(width, height) {
  // Tabla CRC32
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c;
  }
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function makeChunk(type, data) {
    const t = Buffer.from(type, 'ascii');
    const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const crcVal = crc32(Buffer.concat([t, d]));
    const out = Buffer.alloc(4 + 4 + d.length + 4);
    out.writeUInt32BE(d.length, 0);
    t.copy(out, 4);
    d.copy(out, 8);
    out.writeUInt32BE(crcVal, 8 + d.length);
    return out;
  }

  // IHDR: grayscale, 8 bits
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 0;  // color type: grayscale
  // compression, filter, interlace = 0

  // Datos crudos: cada fila = byte de filtro (0) + width bytes 0xFF (blanco)
  const rowLen = 1 + width;
  const raw = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowLen] = 0;                                        // filtro: None
    raw.fill(0xFF, y * rowLen + 1, (y + 1) * rowLen);          // pixels blancos
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), // firma PNG
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', deflateSync(raw)),                             // zlib es el formato correcto para IDAT
    makeChunk('IEND', Buffer.alloc(0))
  ]).toString('base64');
}

function extractUrl(output) {
  if (Array.isArray(output)) return output[0];
  if (typeof output === 'string') return output;
  throw new Error('Formato de output inesperado: ' + JSON.stringify(output));
}

async function urlToBase64Response(url) {
  console.log('[generate] Descargando imagen:', url);
  const imgRes = await fetch(url);
  if (!imgRes.ok) throw new Error('No se pudo descargar la imagen: HTTP ' + imgRes.status + ' — ' + url);
  const mimeType = imgRes.headers.get('content-type') || 'image/webp';
  const buffer = await imgRes.arrayBuffer();
  const imageBase64 = Buffer.from(buffer).toString('base64');
  console.log('[generate] Imagen convertida: ' + mimeType + ', ' + Math.round(buffer.byteLength / 1024) + ' KB');
  return { imageBase64, mimeType };
}
