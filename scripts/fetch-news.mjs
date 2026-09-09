const { readFile, writeFile } = await import('node:fs/promises')

const TOKEN = process.env.DISCORD_TOKEN
const CHANNEL = process.env.DISCORD_CHANNEL_ID
const OUT = process.env.NEWS_OUTPUT || 'news.xml'

if (!TOKEN || !CHANNEL) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CHANNEL_ID')
  process.exit(1)
}

const API = 'https://discord.com/api/v10'
const headers = {
  Authorization: `Bot ${TOKEN}`,
  'User-Agent': 'realmofashes-news/1.0',
  'Content-Type': 'application/json'
}

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

function mdToHtml(raw) {
  const esc = escapeHtml(raw)
  const blocks = []
  let s = esc.replace(/```([\s\S]*?)```/g, (_, c) => {
    blocks.push(`<pre>${c.replace(/\r?\n+/g, '<br>')}</pre>`)
    return `\u0000BLOCK${blocks.length - 1}\u0000`
  })
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>')
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  const lines = s.split(/\r?\n/)
  let html = lines.map((l) => {
    let x = l
    x = x.replace(/^(###\s+)/, '<h3>')
    x = x.replace(/^(##\s+)/, '<h2>')
    x = x.replace(/^(#\s+)/, '<h1>')
    x = x.replace(/^&gt;+\s+/, '<blockquote>')
    x = x.replace(/^[-*]\s+/, '&bull; ')
    return x
  }).join('<br>')
  blocks.forEach((b, i) => {
    html = html.replace(`\u0000BLOCK${i}\u0000`, b)
  })
  return html
}

const stripInline = (text) => String(text)
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/`/g, '')
  .replace(/[*_~#>`<>]/g, '')
  .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
  .replace(/\s+/g, ' ')
  .trim()

async function json(url) {
  const res = await fetch(`${API}${url}`, { headers })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text()}`)
  return res.json()
}

const channel = await json(`/channels/${CHANNEL}`)
if (!channel) {
  console.error(`Channel ${CHANNEL} not found (404). Check permissions/bot.`)
  process.exit(1)
}
const guildId = channel.guild_id

const messages = await json(`/channels/${CHANNEL}/messages?limit=100`) || []
const items = [...messages]
  .filter((m) => {
    const hasText = (m.content || '').trim().length > 0
    const hasEmbed = Array.isArray(m.embeds) && m.embeds.length > 0
    return hasText || hasEmbed
  })
  .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))

if (items.length === 0) {
  console.log('No messages in channel; keeping existing feed.')
  process.exit(0)
}

const mkItem = (m) => {
  const embed = (Array.isArray(m.embeds) && m.embeds.length > 0) ? m.embeds[0] : null
  const rawText = (m.content || '').replace(/\r\n/g, '\n').trim()
  const embedText = embed ? [embed.title, embed.description, embed.footer?.text].filter(Boolean).join('\n') : ''
  const fullText = [rawText, embedText].filter(Boolean).join('\n')

  const firstLine = rawText.split('\n').find((l) => l.trim().length > 0)
  let title = firstLine ? stripInline(firstLine) : (embed?.title ? stripInline(embed.title) : '')
  if (!title) title = stripInline(fullText).slice(0, 80)
  if (!title) return null
  title = title.length > 100 ? title.slice(0, 97) + '...' : title

  const author = m.author?.global_name || m.author?.username || 'Unknown'
  const content = rawText ? mdToHtml(rawText) + (embedText ? '<br><br>' + mdToHtml(embedText) : '') : mdToHtml(embedText)
  const link = `https://discord.com/channels/${guildId}/${CHANNEL}/${m.id}`

  return {
    id: m.id,
    title,
    link,
    author,
    pubDate: new Date(m.timestamp).toUTCString(),
    description: stripInline(fullText).slice(0, 400),
    content
  }
}

const feed = items.map(mkItem).filter(Boolean)

if (feed.length === 0) {
  console.log('No usable items; keeping existing feed.')
  process.exit(0)
}

const channelName = channel.name || 'Najave'
const channelLink = `https://discord.com/channels/${guildId}/${CHANNEL}`

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:slash="http://purl.org/rss/1.0/modules/slash/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>Realm of Ashes - ${escapeHtml(channelName)}</title>
<link>${channelLink}</link>
<description>Objave sa Discord kanala #${escapeHtml(channelName)}</description>
<atom:link href="${channelLink}" rel="self" type="application/rss+xml"/>
<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${feed.map((i) => `  <item>
    <title>${escapeHtml(i.title)}</title>
    <link>${i.link}</link>
    <guid isPermaLink="false">discord-${i.id}</guid>
    <pubDate>${i.pubDate}</pubDate>
    <dc:creator>${escapeHtml(i.author)}</dc:creator>
    <description><![CDATA[${escapeHtml(i.description)}]]></description>
    <content:encoded><![CDATA[${i.content}]]></content:encoded>
    <slash:comments>0</slash:comments>
  </item>`).join('\n')}
</channel>
</rss>
`

let old = ''
try { old = await readFile(OUT, 'utf8') } catch (e) { /* first run */ }

if (old.trim() === xml.trim()) {
  console.log('Feed unchanged.')
} else {
  await writeFile(OUT, xml, 'utf8')
  console.log(`Wrote ${OUT} with ${feed.length} item(s).`)
}