class TradeRain {
  constructor(canvas, opts = {}){
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.particles = [];
    this.running = false;
    this.lastTick = performance.now();
    this.opts = Object.assign({maxParticles:2000, life:1200}, opts);
    this.priceRange = opts.priceRange || {min:30000, max:65000};
    this.bindResize();
  }

  bindResize(){
    const resize = () => {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const rect = this.canvas.getBoundingClientRect();
      this.canvas.width = Math.floor(rect.width * dpr);
      this.canvas.height = Math.floor(rect.height * dpr);
      this.ctx.setTransform(dpr,0,0,dpr,0,0);
    };
    resize();
    window.addEventListener('resize', resize);
  }

  start(){ this.running = true; this.lastTick = performance.now(); this.loop(); }
  stop(){ this.running = false; }

  loop(){
    if(!this.running) return;
    const now = performance.now();
    const dt = now - this.lastTick;
    this.lastTick = now;
    this.update(dt);
    this.draw();
    requestAnimationFrame(()=>this.loop());
  }

  update(dt){
    const now = performance.now();
    // update particles
    for(let i=this.particles.length-1;i>=0;i--){
      const p = this.particles[i];
      p.age = now - p.spawn;
      if(p.age >= p.life){ this.particles.splice(i,1); continue; }
      if(p.animate){
        const t = Math.min(1, p.age / p.life);
        // ease out
        const e = 1 - Math.pow(1-t, 2);
        p.x = p.startX + (p.targetX - p.startX) * e;
        p.y = p.startY + (p.targetY - p.startY) * e;
      }
    }
    // cap
    if(this.particles.length > this.opts.maxParticles){
      this.particles.splice(0, this.particles.length - this.opts.maxParticles);
    }
  }

  draw(){
    const ctx = this.ctx;
    const cw = this.canvas.width / (window.devicePixelRatio||1);
    const ch = this.canvas.height / (window.devicePixelRatio||1);
    ctx.clearRect(0,0,cw,ch);
    // optional grid / price bands
    // draw particles
    for(const p of this.particles){
      const a = 1 - (p.age / p.life);
      ctx.globalAlpha = a * p.opacity;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
      ctx.fill();
      // subtle glow
      ctx.fillStyle = p.color;
      ctx.globalAlpha = 0.06 * p.opacity * a;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r*3, 0, Math.PI*2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  priceToY(price){
    const {min,max} = this.priceRange;
    const ch = this.canvas.height / (window.devicePixelRatio||1);
    const t = (price - min) / (max - min);
    return ch - (t * ch);
  }

  addTrade(trade){
    const cw = this.canvas.width / (window.devicePixelRatio||1);
    const ch = this.canvas.height / (window.devicePixelRatio||1);
    const x = Math.random() * cw; // random across time axis for prototype
    const y = this.priceToY(trade.price);
    const size = Math.max(1, Math.sqrt(trade.volume)) * (trade.vscale||1);
    const color = trade.side === 'buy' ? '#2dd4bf' : '#fb7185';
    const life = trade.lifeMs || this.opts.life;
    const animate = trade.animate !== undefined ? trade.animate : true;
    const particle = {
      startX: x,
      startY: -10,
      targetX: x,
      targetY: y,
      x: x, y: -10,
      r: size,
      color,
      opacity: 1,
      spawn: performance.now(),
      age: 0,
      life,
      animate
    };
    this.particles.push(particle);
  }
}

// Simple trade generator to simulate incoming trades
class TradeGenerator{
  constructor(onTrade, opts={}){
    this.onTrade = onTrade;
    this.rate = opts.rate || 30; // trades per second
    this.vscale = opts.vscale || 3;
    this.priceRange = opts.priceRange || {min:30000, max:65000};
    this.running = false;
    this._tick = this._tick.bind(this);
  }

  start(){ this.running = true; this._tick(); }
  stop(){ this.running = false; }

  _tick(){
    if(!this.running) return;
    // emit more than 1 per raf if rate high
    const perFrame = Math.max(1, Math.round(this.rate / 60));
    for(let i=0;i<perFrame;i++){
      const side = Math.random() > 0.5 ? 'buy' : 'sell';
      const price = this.priceRange.min + Math.random() * (this.priceRange.max - this.priceRange.min);
      const volume = Math.pow(Math.random(), 2) * 5000; // skew small volumes
      this.onTrade({timestamp:Date.now(), price, volume, side, vscale:this.vscale});
    }
    requestAnimationFrame(this._tick);
  }
}

// Wire UI
const canvas = document.getElementById('chart');
const rain = new TradeRain(canvas, {maxParticles:3000, life:1200, priceRange:{min:32000, max:64000}});
const gen = new TradeGenerator(t=>rain.addTrade(t), {rate:30, vscale:3, priceRange:rain.priceRange});
rain.start(); gen.start();

// UI
const btn = document.getElementById('btn-toggle');
const rate = document.getElementById('rate');
const rateVal = document.getElementById('rate-val');
const vscale = document.getElementById('vscale');
const vscaleVal = document.getElementById('vscale-val');
const animate = document.getElementById('animate');

btn.addEventListener('click', ()=>{
  if(gen.running){ gen.stop(); rain.stop(); btn.textContent = 'Start'; }
  else { gen.start(); rain.start(); btn.textContent = 'Stop'; }
});
rate.addEventListener('input', ()=>{ gen.rate = Number(rate.value); rateVal.textContent = rate.value; });
vscale.addEventListener('input', ()=>{ gen.vscale = Number(vscale.value); vscaleVal.textContent = vscale.value; });
animate.addEventListener('change', ()=>{ /* generator sets animate per particle by default */ });

// expose for debugging
window.__tradeRain = {rain, gen};
