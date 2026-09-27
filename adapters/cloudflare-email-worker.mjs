// Cloudflare Email Worker. Bundle this file with postal-mime and configure
// WORKSPACE_WEBHOOK_URL and WORKSPACE_WEBHOOK_SECRET as Worker secrets.
import PostalMime from 'postal-mime';

const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2,'0')).join('');
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return hex(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(text)));
}
async function sha256(text) { return hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))); }
function plainFallback(html) { return String(html||'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/\s+/g,' ').trim(); }
export default {
  async email(message,env) {
    if (!env.WORKSPACE_WEBHOOK_URL || !env.WORKSPACE_WEBHOOK_SECRET) throw new Error('Worker secrets are missing');
    if (message.rawSize > 2_000_000) { message.setReject('Message too large'); return; }
    const parsed=await PostalMime.parse(message.raw);
    const recipient=String(message.to||'').toLowerCase(); // SMTP envelope recipient, not untrusted To header
    const sender=String(message.from||'').toLowerCase();
    const text=(parsed.text || plainFallback(parsed.html)).slice(0,200_000);
    const messageId=parsed.messageId || await sha256(`${recipient}\n${sender}\n${parsed.subject||''}\n${text}`);
    const body=JSON.stringify({recipient,from:sender,subject:parsed.subject||'',text,messageId,receivedAt:new Date().toISOString()});
    const timestamp=Math.floor(Date.now()/1000);
    const signature=await hmac(env.WORKSPACE_WEBHOOK_SECRET,`${timestamp}.${body}`);
    const response=await fetch(env.WORKSPACE_WEBHOOK_URL,{method:'POST',headers:{'Content-Type':'application/json','X-Workspace-Timestamp':String(timestamp),'X-Workspace-Signature':signature},body});
    if (response.status===404) { message.setReject('Unknown address'); return; }
    if (!response.ok) throw new Error(`Workspace inbound returned HTTP ${response.status}`);
  }
};
