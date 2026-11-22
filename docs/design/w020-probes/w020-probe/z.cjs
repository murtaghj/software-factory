const z=require("node:zlib");
const a=z.deflateSync(Buffer.alloc(1000,65)); const junk=Buffer.concat([a,Buffer.from("TRAILINGJUNK")]);
const r=z.inflateSync(junk,{info:true}); console.log("trailing ok, out",r.buffer.length,"consumed",r.engine.bytesWritten,"deflated",a.length);
try{ z.inflateSync(z.deflateSync(Buffer.alloc(50_000_000)),{maxOutputLength:1_000_000}); console.log("NO LIMIT"); }catch(e){ console.log("limit:",e.code); }
const bomb=z.deflateSync(Buffer.alloc(200_000_000),{level:9}); console.log("bomb bytes",bomb.length,"ratio",Math.round(200_000_000/bomb.length));
const t=process.hrtime.bigint(); try{ z.inflateSync(bomb,{maxOutputLength:4096}); }catch(e){ console.log("bomb refused:",e.code,"in ms",Number(process.hrtime.bigint()-t)/1e6,"rss MB",Math.round(process.memoryUsage().rss/1e6)); }
try{ z.inflateSync(a.subarray(0,a.length-3)); console.log("truncated accepted?!"); }catch(e){ console.log("truncated:",e.code); }
try{ z.inflateSync(Buffer.from("not zlib at all")); }catch(e){ console.log("garbage:",e.code); }
try{ const d=z.deflateSync(Buffer.from("hello"),{dictionary:Buffer.from("hello")}); z.inflateSync(d); console.log("dict accepted"); }catch(e){ console.log("dict:",e.code); }
