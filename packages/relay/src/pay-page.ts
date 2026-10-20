import qrcode from 'qrcode-generator'
import type { Plan } from './payments'
import { escapeHtml } from './util/http'

/** SVG QR code (byte mode, error correction M) for an invoice, uppercased for denser alphanumeric-friendly codes. */
export function qrSvg(text: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(text.startsWith('ln') ? `lightning:${text}`.toUpperCase() : text)
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
}

/** Server-rendered /pay page: Nostr login (NIP-07) or pasted npub, plan choice, invoice + QR, polling. */
export function payPage(opts: {
  relayName: string
  plans: Plan[]
  enabled: boolean
  base: string
}): string {
  const plans = opts.plans
    .map(
      (p) => `<label class="plan"><input type="radio" name="plan" value="${p.id}">
        <span><b>${escapeHtml(p.name)}</b> · ${p.amountSats.toLocaleString('en-US')} sats / ${p.durationDays} days
        ${p.description ? `<small>${escapeHtml(p.description)}</small>` : ''}</span></label>`,
    )
    .join('')
  const body = !opts.enabled
    ? '<p class="muted">Payments are not enabled on this relay.</p>'
    : !opts.plans.length
      ? '<p class="muted">No plans are available yet.</p>'
      : `<form id="f">
      <fieldset><legend>1 · Who pays</legend>
        <button type="button" id="login">Sign in with Nostr</button>
        <input id="pubkey" name="pubkey" placeholder="npub1… or hex pubkey" autocomplete="off" required>
      </fieldset>
      <fieldset><legend>2 · Plan</legend>${plans}</fieldset>
      <button type="submit" id="go">Get invoice</button>
    </form>
    <section id="inv" hidden>
      <div id="qr"></div>
      <textarea id="bolt11" readonly rows="4"></textarea>
      <p><a id="open" href="#">Open in wallet</a> · <button type="button" id="copy">Copy</button></p>
      <p id="status" class="muted">Waiting for payment…</p>
    </section>`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pay · ${escapeHtml(opts.relayName)}</title>
<style>
:root{color-scheme:dark;--bg:#0B0E1A;--fg:#E6E8F2;--muted:#8A90A8;--teal:#5EEAD4;--violet:#8B7BFF;--card:#141829}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;padding:16px}
main{max-width:480px;margin:0 auto}h1{font-size:1.4rem;margin:.5rem 0 1rem}h1 span{color:var(--teal)}
fieldset{border:1px solid #262b45;border-radius:12px;padding:12px;margin:0 0 12px;background:var(--card)}
legend{color:var(--muted);padding:0 6px}input,textarea{width:100%;padding:10px;border-radius:8px;border:1px solid #2f3555;background:#0f1222;color:var(--fg);font:inherit}
button{background:var(--violet);color:#fff;border:0;border-radius:8px;padding:10px 14px;font:inherit;cursor:pointer;margin:0 0 8px}
#go{background:var(--teal);color:#0B0E1A;width:100%}.plan{display:flex;gap:10px;padding:8px 0;align-items:flex-start}
.plan input{width:auto;margin-top:6px}small{display:block;color:var(--muted)}.muted{color:var(--muted)}
#qr svg{width:100%;height:auto;background:#fff;border-radius:12px}a{color:var(--teal)}.ok{color:var(--teal)}.err{color:#ff7b8b}
</style></head>
<body><main>
<h1><span>⚡</span> ${escapeHtml(opts.relayName)}</h1>
<p class="muted">Pay with Lightning to get write access for your Nostr pubkey.</p>
${body}
</main>
<script>
const $=(id)=>document.getElementById(id)
const base=${JSON.stringify(opts.base)}
$('login')?.addEventListener('click',async()=>{
  if(!window.nostr){alert('No Nostr extension (NIP-07) found. Paste your npub instead.');return}
  try{$('pubkey').value=await window.nostr.getPublicKey()}catch(e){alert(e.message||e)}
})
$('f')?.addEventListener('submit',async(e)=>{
  e.preventDefault()
  const plan=document.querySelector('input[name=plan]:checked')
  if(!plan){alert('Choose a plan');return}
  $('go').disabled=true
  try{
    const r=await fetch(base+'/pay/invoice',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pubkey:$('pubkey').value,planId:Number(plan.value)})})
    const j=await r.json()
    if(!r.ok)throw new Error(j.error?.message||'failed')
    $('inv').hidden=false;$('qr').innerHTML=j.qr;$('bolt11').value=j.invoice;$('open').href='lightning:'+j.invoice
    poll(j.paymentHash)
  }catch(err){alert(err.message)}finally{$('go').disabled=false}
})
$('copy')?.addEventListener('click',()=>navigator.clipboard.writeText($('bolt11').value))
async function poll(hash){
  for(;;){
    await new Promise(r=>setTimeout(r,3000))
    const r=await fetch(base+'/pay/invoice/'+hash);const j=await r.json()
    if(j.status==='paid'){$('status').className='ok';$('status').textContent='Paid. Write access until '+new Date(j.paidUntil*1000).toLocaleString();return}
    if(j.status==='expired'){$('status').className='err';$('status').textContent='Invoice expired. Request a new one.';return}
  }
}
</script>
</body></html>`
}
