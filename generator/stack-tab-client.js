// Stack tab client — embedded in the normal PR page (see generate.js
// renderStackTabPanel / renderV2Page). Ported from stack-client.js: same rail
// + peel + why-drawer behaviour, but reads STACK_DATA/STACK_DEFAULT_LAYER
// (namespaced so it can't collide with the page's own DATA global if one is
// ever added) and skips theme-toggle wiring — the page shell already owns the
// single theme toggle button.
(function () {
  var LAYERS = STACK_DATA.LAYERS, DECISIONS = STACK_DATA.DECISIONS, FILES = STACK_DATA.FILES, SEAMS = STACK_DATA.seams || {};
  function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
  function num(n){return n==null?"":n.toLocaleString();}

  var totAdds = LAYERS.reduce(function(a,L){return a+L.adds;},0);
  var totDels = LAYERS.reduce(function(a,L){return a+L.dels;},0);
  var top = LAYERS[LAYERS.length-1].pr, bot = LAYERS[0].pr;
  var initial = (typeof STACK_DEFAULT_LAYER !== "undefined" && STACK_DEFAULT_LAYER != null) ? String(STACK_DEFAULT_LAYER) : "net";

  document.getElementById("st-summary").innerHTML = LAYERS.length>1
    ? LAYERS.length+" layers · #"+bot+"→#"+top+" on <code>main</code> · +"+num(totAdds)+" / −"+num(totDels)+" · "+Object.keys(SEAMS).length+" seam files"
    : "single slice · #"+top+" on <code>main</code> · +"+num(totAdds)+" / −"+num(totDels);

  function renderRail(){
    var h='<div class="st-rail-h">Layers · bottom → top</div>';
    h+='<button class="st-lyr'+(initial==="net"?" on":"")+'" data-layer="net"><div class="st-lyr-top"><span class="st-lyr-pr">NET</span><span class="st-lyr-phase">main…#'+top+'</span></div>'
      +'<div class="st-lyr-title">The whole stack, as it merges to main</div>'
      +'<div class="st-lyr-stats"><span class="st-add">+'+num(totAdds)+'</span><span class="st-del">−'+num(totDels)+'</span><span>· '+LAYERS.length+' layers</span></div></button>';
    LAYERS.slice().reverse().forEach(function(L){
      var on = initial===L.layer ? " on" : "";
      h+='<button class="st-lyr'+on+'" data-layer="'+L.layer+'"><div class="st-lyr-top"><span class="st-lyr-pr">#'+L.pr+'</span><span class="st-lyr-phase">'+L.phase+'</span></div>'
        +'<div class="st-lyr-title">'+L.title+'</div>'
        +'<div class="st-lyr-stats"><span class="st-add">+'+num(L.adds)+'</span><span class="st-del">−'+L.dels+'</span><span>· '+L.files+'f</span></div>'
        +'<div class="st-lyr-foot"><span class="st-prov">'+L.prov+'</span><span class="st-dcount">'+L.decisions+' decisions</span></div>'
        +(L.edge?'<div class="st-edge-note">↳ '+L.edge+'</div>':'')+'</button>';
    });
    document.getElementById("st-rail").innerHTML=h;
  }

  function statusClass(s){
    if(!s) return "";
    if(/done|complete|closed|merged|resolved/i.test(s)) return "done";
    if(/review|progress|dev|flight|open/i.test(s)) return "prog";
    return "";
  }
  function renderEpic(){
    var e=STACK_DATA.epic; if(!e) return "";
    return '<div class="st-epic"><div class="st-epic-top"><span class="st-epic-badge">'+esc(e.badge||"Epic")+'</span>'
      +((e.src||e.key)?'<span class="st-epic-key">'+esc(e.src||e.key)+'</span>':"")
      +(e.status?'<span class="st-jstatus '+statusClass(e.status)+'">'+esc(e.status)+'</span>':"")
      +'<span class="st-epic-sum">'+esc(e.title||e.summary||"")+'</span></div>'
      +(e.goal?'<p class="st-epic-goal">'+e.goal+'</p>':"")
      +(e.note?'<p class="st-epic-note">'+esc(e.note)+'</p>':"")
      +'<div class="st-epic-phases">'+LAYERS.map(function(L){return '<span class="st-epic-phase">#'+L.pr+' · '+L.phase+'</span>';}).join("")+'</div></div>';
  }
  function renderAc(list){
    if(!list||!list.length) return "";
    var items=list.map(function(a){
      return '<li><span class="st-acid">'+esc(a.id)+'</span><span class="st-actxt">'+esc(a.text)+'</span></li>';
    }).join("");
    return '<details class="st-lyr-ac"><summary>Acceptance criteria · '+list.length+'</summary><ul>'+items+'</ul></details>';
  }

  function ownerDots(path, ownLayer){
    var ls = SEAMS[path] || [ownLayer];
    return ls.map(function(o){return '<span class="st-odot" data-layer="'+o+'"></span>';}).join("");
  }

  function renderFile(f){
    var seam = SEAMS[f.path] ? '<span class="st-seam">seam · '+SEAMS[f.path].length+'</span>' : "";
    var open = f.hasAnchor;
    var h='<div class="st-file'+(open?"":" collapsed")+'" data-file="'+esc(f.path)+'">'
      +'<div class="st-fhead"><span class="st-chev">▸</span><span class="st-fp">'+esc(f.path)+'</span>'
      +'<span class="st-fmeta">'+seam+'<span class="st-fowners">'+ownerDots(f.path,f.layer)+'</span>'
      +'<span class="st-add">+'+f.adds+'</span><span class="st-del">−'+f.dels+'</span></span></div><div class="st-fbody">';
    f.hunks.forEach(function(hk){
      h+='<div class="st-hunk-head">'+esc(hk.header)+'</div><pre class="st-code">';
      hk.lines.forEach(function(ln){
        var cls="st-dl"+(ln.s==="+"?" st-add":ln.s==="-"?" st-del":"")+(ln.d?" st-attr":"");
        var la = ln.s==="+"?' data-layer="'+f.layer+'"':"";
        var da = ln.d?' data-decision="'+ln.d+'"':"";
        var lnum = ln.n!=null?ln.n:(ln.o!=null?ln.o:"");
        h+='<div class="'+cls+'"'+la+da+'><span class="st-ln">'+lnum+'</span><span class="st-sign">'+(ln.s===" "?"":ln.s)+'</span><span class="st-txt">'+esc(ln.t)+'</span></div>';
      });
      h+='</pre>';
    });
    return h+'</div></div>';
  }

  function renderDiff(){
    var h=renderEpic();
    LAYERS.forEach(function(L,i){
      var files = FILES.filter(function(f){return +f.layer===i;});
      h+='<section class="st-lyr-section" data-layer="'+i+'"><div class="st-lyr-masthead"><span class="st-lyr-pr">#'+L.pr+'</span>'
        +'<span class="st-mh-phase">'+L.phase+'</span>'
        +'<span class="st-mh-title">'+L.title+'</span>'
        +'<span class="st-mh-stats"><span class="st-add">+'+num(L.adds)+'</span> <span class="st-del">−'+L.dels+'</span> · '+files.length+'f</span></div>';
      var t=L.ticket;
      if(L.summary||t){
        h+='<div class="st-lyr-why">';
        if(t&&t.capability){
          h+='<div class="st-lyr-ticket"><span class="st-req-chip">TDD</span>'
            +'<span class="st-tsum">Capability — '+esc(t.capability)+'</span></div>';
        }
        h+='<span class="st-lyr-why-lbl">Why this exists</span><p>'+((t&&t.context)?t.context:L.summary)+'</p>'
          +(L.edge?'<p class="st-lyr-why-edge">↳ '+L.edge+'</p>':'')
          +(t?renderAc(t.ac):"")+'</div>';
      }
      h+='<div class="st-lyr-files-div"><span>Files · '+files.length+'</span></div><div class="st-lyr-files">';
      files.forEach(function(f){h+=renderFile(f);});
      h+='</div></section>';
    });
    document.getElementById("st-diffcol").innerHTML=h;
  }

  function renderWhy(){
    var h='<div class="st-why-hint">Why this line</div>'
      +'<div class="st-why-empty" id="st-why-empty">Click a tinted line in the diff to see the decision behind it — and, where it sits on a lower layer, the builds-on seam.</div>';
    Object.keys(DECISIONS).forEach(function(k){
      var d=DECISIONS[k];
      h+='<div class="st-wcard" data-decision="'+k+'">'
        +'<div class="st-wc-head"><span class="st-wc-layer" data-layer="'+d.layer+'">#'+LAYERS[+d.layer].pr+'</span><span class="st-wc-num">'+d.num+'</span><span class="st-wc-prov">'+d.prov+'</span></div>'
        +'<div class="st-wc-title">'+d.title+'</div>'
        +'<p class="st-wc-chose">'+d.chose+'</p>'
        +'<div class="st-wc-contrast"><span class="st-wc-ck">'+d.ck+'</span><span class="st-wc-cv">'+d.cv+'</span></div>'
        +'<div class="st-wc-lbl">Why it matters</div><p class="st-wc-why">'+d.why+'</p>'
        +(d.edge?'<div class="st-wc-edge"><span class="st-es">builds-on seam → '+d.edge.to+'</span>'+d.edge.text+'</div>':'')
        +'</div>';
    });
    document.getElementById("st-why").innerHTML=h;
  }

  var state={sel:initial,cumulative:false};
  function applyPeel(){
    var selInt = state.sel==="net"?null:+state.sel;
    Array.prototype.forEach.call(document.querySelectorAll("#view-stack .st-lyr-section"),function(sec){
      var lv=+sec.getAttribute("data-layer");
      var vis = selInt===null?true:state.cumulative?lv<=selInt:lv===selInt;
      sec.hidden=!vis;
    });
    var st = state.sel==="net"?"net · main…#"+top
      :(state.cumulative?"through #"+LAYERS[selInt].pr+" · main…#"+LAYERS[selInt].pr
        :"only #"+LAYERS[selInt].pr+" · "+LAYERS[selInt].phase);
    document.getElementById("st-peel-state").textContent=st;
  }

  function wire(){
    Array.prototype.forEach.call(document.querySelectorAll("#view-stack .st-fhead"),function(hd){
      hd.addEventListener("click",function(){hd.parentNode.classList.toggle("collapsed");});
    });
    var rail=document.querySelectorAll("#view-stack .st-lyr");
    Array.prototype.forEach.call(rail,function(b){
      b.addEventListener("click",function(){
        Array.prototype.forEach.call(rail,function(x){x.classList.toggle("on",x===b);});
        state.sel=b.getAttribute("data-layer");
        applyPeel();
      });
    });
    document.getElementById("st-peel-cumulative").addEventListener("change",function(e){
      state.cumulative=e.target.checked;applyPeel();
    });
    document.getElementById("st-diffcol").addEventListener("click",function(e){
      var line=e.target.closest?e.target.closest(".st-dl.st-attr"):null;
      if(!line)return;
      var id=line.getAttribute("data-decision");
      Array.prototype.forEach.call(document.querySelectorAll("#view-stack .st-dl.st-attr"),function(l){l.classList.toggle("st-sel",l===line);});
      var em=document.getElementById("st-why-empty"); if(em)em.hidden=true;
      Array.prototype.forEach.call(document.querySelectorAll("#view-stack .st-wcard"),function(c){c.classList.toggle("on",c.getAttribute("data-decision")===id);});
      document.getElementById("st-why").scrollTop=0;
    });
  }

  renderRail();renderDiff();renderWhy();wire();applyPeel();
})();
