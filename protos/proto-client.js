(function () {
  var LAYERS = DATA.LAYERS, DECISIONS = DATA.DECISIONS, FILES = DATA.FILES, SEAMS = DATA.seams || {};
  function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
  function num(n){return n==null?"":n.toLocaleString();}

  var totAdds = LAYERS.reduce(function(a,L){return a+L.adds;},0);
  var totDels = LAYERS.reduce(function(a,L){return a+L.dels;},0);
  var top = LAYERS[LAYERS.length-1].pr, bot = LAYERS[0].pr;
  document.getElementById("brand-meta").innerHTML = LAYERS.length>1
    ? "· "+LAYERS.length+" layers · #"+bot+"→#"+top+" on <code>main</code> · +"+num(totAdds)+" / −"+num(totDels)+" · "+Object.keys(SEAMS).length+" seam files"
    : "· single slice · #"+top+" on <code>main</code> · +"+num(totAdds)+" / −"+num(totDels);

  function renderRail(){
    var h='<div class="rail-h">Layers · bottom → top</div>';
    h+='<button class="lyr on" data-layer="net"><div class="lyr-top"><span class="lyr-pr">NET</span><span class="lyr-phase">main…#'+top+'</span></div>'
      +'<div class="lyr-title">The whole stack, as it merges to main</div>'
      +'<div class="lyr-stats"><span class="adds">+'+num(totAdds)+'</span><span class="dels">−'+num(totDels)+'</span><span>· '+LAYERS.length+' layers</span></div></button>';
    LAYERS.slice().reverse().forEach(function(L){
      h+='<button class="lyr" data-layer="'+L.layer+'"><div class="lyr-top"><span class="lyr-pr">#'+L.pr+'</span><span class="lyr-phase">'+L.phase+'</span></div>'
        +'<div class="lyr-title">'+L.title+'</div>'
        +'<div class="lyr-stats"><span class="adds">+'+num(L.adds)+'</span><span class="dels">−'+L.dels+'</span><span>· '+L.files+'f</span></div>'
        +'<div class="lyr-foot"><span class="prov">'+L.prov+'</span><span class="dcount">'+L.decisions+' decisions</span></div>'
        +(L.edge?'<div class="edge-note">↳ '+L.edge+'</div>':'')+'</button>';
    });
    document.getElementById("rail").innerHTML=h;
  }

  function statusClass(s){
    if(!s) return "";
    if(/done|complete|closed|merged|resolved/i.test(s)) return "done";
    if(/review|progress|dev|flight|open/i.test(s)) return "prog";
    return "";
  }
  function renderEpic(){
    var e=DATA.epic; if(!e) return "";
    return '<div class="epic"><div class="epic-top"><span class="epic-badge">'+esc(e.badge||"Epic")+'</span>'
      +((e.src||e.key)?'<span class="epic-key">'+esc(e.src||e.key)+'</span>':"")
      +(e.status?'<span class="jstatus '+statusClass(e.status)+'">'+esc(e.status)+'</span>':"")
      +'<span class="epic-sum">'+esc(e.title||e.summary||"")+'</span></div>'
      +(e.goal?'<p class="epic-goal">'+e.goal+'</p>':"")
      +(e.note?'<p class="epic-note">'+esc(e.note)+'</p>':"")
      +'<div class="epic-phases">'+LAYERS.map(function(L){return '<span class="epic-phase">#'+L.pr+' · '+L.phase+'</span>';}).join("")+'</div></div>';
  }
  function renderAc(list){
    if(!list||!list.length) return "";
    var items=list.map(function(a){
      return '<li><span class="acid">'+esc(a.id)+'</span><span class="actxt">'+esc(a.text)+'</span></li>';
    }).join("");
    return '<details class="lyr-ac"><summary>Acceptance criteria · '+list.length+'</summary><ul>'+items+'</ul></details>';
  }

  function ownerDots(path, ownLayer){
    var ls = SEAMS[path] || [ownLayer];
    return ls.map(function(o){return '<span class="odot" data-layer="'+o+'"></span>';}).join("");
  }

  function renderFile(f){
    var seam = SEAMS[f.path] ? '<span class="seam">seam · '+SEAMS[f.path].length+'</span>' : "";
    var open = f.hasAnchor;
    var h='<div class="diff-file'+(open?"":" collapsed")+'" data-file="'+esc(f.path)+'">'
      +'<div class="fhead"><span class="chev">▸</span><span class="fp">'+esc(f.path)+'</span>'
      +'<span class="fmeta">'+seam+'<span class="fowners">'+ownerDots(f.path,f.layer)+'</span>'
      +'<span class="adds">+'+f.adds+'</span><span class="dels">−'+f.dels+'</span></span></div><div class="fbody">';
    f.hunks.forEach(function(hk){
      h+='<div class="hunk-head">'+esc(hk.header)+'</div><pre class="code">';
      hk.lines.forEach(function(ln){
        var cls="dl"+(ln.s==="+"?" add":ln.s==="-"?" del":"")+(ln.d?" attr":"");
        var la = ln.s==="+"?' data-layer="'+f.layer+'"':"";
        var da = ln.d?' data-decision="'+ln.d+'"':"";
        var lnum = ln.n!=null?ln.n:(ln.o!=null?ln.o:"");
        h+='<div class="'+cls+'"'+la+da+'><span class="ln">'+lnum+'</span><span class="sign">'+(ln.s===" "?"":ln.s)+'</span><span class="txt">'+esc(ln.t)+'</span></div>';
      });
      h+='</pre>';
    });
    return h+'</div></div>';
  }

  function renderDiff(){
    var h=renderEpic();
    LAYERS.forEach(function(L,i){
      var files = FILES.filter(function(f){return +f.layer===i;});
      h+='<section class="lyr-section" data-layer="'+i+'"><div class="lyr-masthead"><span class="lyr-pr">#'+L.pr+'</span>'
        +'<span class="mh-phase">'+L.phase+'</span>'
        +'<span class="mh-title">'+esc(L.title.replace(/<[^>]+>/g,""))+'</span>'
        +'<span class="mh-stats"><span class="adds">+'+num(L.adds)+'</span> <span class="dels">−'+L.dels+'</span> · '+files.length+'f</span></div>';
      var t=L.ticket;
      if(L.summary||t){
        h+='<div class="lyr-why">';
        if(t&&t.capability){
          h+='<div class="lyr-ticket"><span class="req-chip">TDD</span>'
            +'<span class="tsum">Capability — '+esc(t.capability)+'</span></div>';
        }
        h+='<span class="lyr-why-lbl">Why this exists</span><p>'+((t&&t.context)?t.context:L.summary)+'</p>'
          +(L.edge?'<p class="lyr-why-edge">↳ '+L.edge+'</p>':'')
          +(t?renderAc(t.ac):"")+'</div>';
      }
      h+='<div class="lyr-files-div"><span>Files · '+files.length+'</span></div><div class="lyr-files">';
      files.forEach(function(f){h+=renderFile(f);});
      h+='</div></section>';
    });
    document.getElementById("diffcol").innerHTML=h;
  }

  function renderWhy(){
    var h='<div class="why-hint">Why this line</div>'
      +'<div class="why-empty" id="why-empty">Click a tinted line in the diff to see the decision behind it — and, where it sits on a lower layer, the builds-on seam.</div>';
    Object.keys(DECISIONS).forEach(function(k){
      var d=DECISIONS[k];
      h+='<div class="wcard" data-decision="'+k+'">'
        +'<div class="wc-head"><span class="wc-layer" data-layer="'+d.layer+'">#'+LAYERS[+d.layer].pr+'</span><span class="wc-num">'+d.num+'</span><span class="wc-prov">'+d.prov+'</span></div>'
        +'<div class="wc-title">'+d.title+'</div>'
        +'<p class="wc-chose">'+d.chose+'</p>'
        +'<div class="wc-contrast"><span class="wc-ck">'+d.ck+'</span><span class="wc-cv">'+d.cv+'</span></div>'
        +'<div class="wc-lbl">Why it matters</div><p class="wc-why">'+d.why+'</p>'
        +(d.edge?'<div class="wc-edge"><span class="es">builds-on seam → '+d.edge.to+'</span>'+d.edge.text+'</div>':'')
        +'</div>';
    });
    document.getElementById("why").innerHTML=h;
  }

  var state={sel:"net",cumulative:false};
  function applyPeel(){
    var selInt = state.sel==="net"?null:+state.sel;
    Array.prototype.forEach.call(document.querySelectorAll(".lyr-section"),function(sec){
      var lv=+sec.getAttribute("data-layer");
      var vis = selInt===null?true:state.cumulative?lv<=selInt:lv===selInt;
      sec.hidden=!vis;
    });
    var st = state.sel==="net"?"net · main…#"+top
      :(state.cumulative?"through #"+LAYERS[selInt].pr+" · main…#"+LAYERS[selInt].pr
        :"only #"+LAYERS[selInt].pr+" · "+LAYERS[selInt].phase);
    document.getElementById("peel-state").textContent=st;
  }

  function wire(){
    document.getElementById("theme-toggle").addEventListener("click",function(){
      var r=document.documentElement,c=r.getAttribute("data-theme");
      var dark=c?c==="dark":matchMedia("(prefers-color-scheme: dark)").matches;
      r.setAttribute("data-theme",dark?"light":"dark");
    });
    Array.prototype.forEach.call(document.querySelectorAll(".fhead"),function(hd){
      hd.addEventListener("click",function(){hd.parentNode.classList.toggle("collapsed");});
    });
    var rail=document.querySelectorAll(".lyr");
    Array.prototype.forEach.call(rail,function(b){
      b.addEventListener("click",function(){
        Array.prototype.forEach.call(rail,function(x){x.classList.toggle("on",x===b);});
        state.sel=b.getAttribute("data-layer");
        applyPeel();
      });
    });
    document.getElementById("peel-cumulative").addEventListener("change",function(e){
      state.cumulative=e.target.checked;applyPeel();
    });
    document.getElementById("diffcol").addEventListener("click",function(e){
      var line=e.target.closest?e.target.closest(".dl.attr"):null;
      if(!line)return;
      var id=line.getAttribute("data-decision");
      Array.prototype.forEach.call(document.querySelectorAll(".dl.attr"),function(l){l.classList.toggle("sel",l===line);});
      var em=document.getElementById("why-empty"); if(em)em.hidden=true;
      Array.prototype.forEach.call(document.querySelectorAll(".wcard"),function(c){c.classList.toggle("on",c.getAttribute("data-decision")===id);});
      document.getElementById("why").scrollTop=0;
    });
  }

  renderRail();renderDiff();renderWhy();wire();applyPeel();
})();
