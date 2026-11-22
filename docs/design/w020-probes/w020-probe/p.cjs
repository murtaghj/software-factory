const fs=require("node:fs"); const cp=require("node:child_process");
const tryIt=(n,f)=>{ try{ f(); console.log(n,"ALLOWED"); }catch(e){ console.log(n,"denied:",e.code); } };
tryIt("read inside", ()=>fs.readFileSync(process.argv[2]+"/seed/a.txt"));
tryIt("read outside", ()=>fs.readFileSync("/etc/hosts"));
tryIt("symlink out", ()=>fs.readFileSync(process.argv[2]+"/esc"));
tryIt("write inside", ()=>fs.writeFileSync(process.argv[2]+"/x.tmp","x"));
tryIt("spawn", ()=>cp.spawnSync("/bin/echo",["hi"]));
tryIt("lstat outside", ()=>fs.lstatSync("/etc/hosts"));
console.log("O_NOFOLLOW", fs.constants.O_NOFOLLOW, "O_DIRECTORY", fs.constants.O_DIRECTORY);
