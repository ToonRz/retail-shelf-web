# retail-shelf-web

เว็บตรวจจับสินค้าบนชั้นวาง **รัน model ใน browser** ไม่มี server (host บน GitHub Pages ฟรี)
ใช้ agent จาก [retail-shelf-agent](https://github.com/ToonRz/retail-shelf-agent) โดย pin เวอร์ชันไว้ใน `agent.version`
(แบบเดียวกับ zcrX pin zcrAgentX)

- Spec: [retail-shelf-detection/docs/agent-connection/SPEC.md](https://github.com/ToonRz/retail-shelf-detection/blob/main/docs/agent-connection/SPEC.md)
- งานที่เหลือและเจ้าของงาน: [TASKS.md](https://github.com/ToonRz/retail-shelf-detection/blob/main/docs/agent-connection/TASKS.md)

## agent.version

| ค่า | ผล |
|---|---|
| `mock` | ใช้ `src/mockAgent.ts` (กล่องปลอม) — ใช้จนกว่าจะมี release แรก |
| `vX.Y.Z` | โหลด `<base>agent/vX.Y.Z/shelf-agent.js` ซึ่ง `make fetch-agent-release` (งาน C2) วางไว้ใน `public/agent/vX.Y.Z/` ตอน build — ไม่ commit |

ค่าอื่นทำให้ build ล้ม (`vite.config.ts: readAgentVersion`) · เว็บคุยกับ agent ผ่าน `src/agent.ts` ที่เดียว ตาม interface ใน `src/agent-contract.ts`

## Dev

```bash
npm ci
npm run dev       # http://localhost:5173/retail-shelf-web/
npm test
npm run build     # dist/ สำหรับ GitHub Pages
```

## สถานะ

| ส่วน | สถานะ |
|---|---|
| pin `agent.version` + ตรวจรูปแบบ, `loadAgent()` (mock / release จริง), mock agent | ✅ มี test · ทดสอบใน browser แล้วว่าโหลด release จริงได้ถึงขั้น createSession |
| หน้า UI จริง (อัปรูป / กล้อง / กล่อง / นับสินค้า / progress) | ⏳ งาน B |
| `make bump-agent`, `make fetch-agent-release`, deploy Pages | ⏳ งาน C2, C3 |
| GitHub Pages (Source: GitHub Actions) | ✅ เปิดแล้ว · เว็บจะขึ้นเมื่อมี `pages.yml` (C3) |
| bump ไป `v0.1.0` | ⛔ งาน T4 รอ release แรกของ agent |
