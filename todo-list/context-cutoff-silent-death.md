# Context sınırına ulaşınca sessiz ölüm ve sonsuz "output-length cutoff" döngüsü

- **Durum:** Not alındı, düzeltme ertelendi.
- **Tarih:** 2026-09-01
- **Branş:** `research/lab-1`
- **Nasıl görüldü:** Lokal bir modelle (Qwen 3.6 35B, OpenAI-uyumlu endpoint) uzun bir
  kod yazma turunda. Transkript `↻ continuing after output-length cutoff` satırını
  arka arkaya bastı, model her seferinde aynı dosyayı "sıfırdan yazıyorum" diyerek
  yeniden başlattı, sonunda tur görünür bir hata vermeden bitti.

## Zincir

### 1. Context penceresi compaction'a hiç bağlı değil

- `engine/core/src/config/pricing.ts:57` — `MODEL_CONTEXT_WINDOWS` **boş bir dizi**.
  Dolayısıyla `contextWindowFor()` (`pricing.ts:66`) her model için sabit `128_000`
  döndürüyor.
- `contextWindowFor()` yalnızca iki yerde çağrılıyor: `engine/core/src/runtime/engine.ts:297`
  (bir uyarı metni) ve `engine.ts:1605` (rate card). **Compaction yolunda hiç çağrılmıyor.**
- `Session.maybeCompact()` (`engine/core/src/runtime/session.ts:2480`) yalnızca
  `autoCompactLimit`e bakıyor:

  ```ts
  if (this.autoCompactLimit <= 0 || this.stats.contextTokens < this.autoCompactLimit) return false;
  ```

- `autoCompactLimit`in tek kaynağı UI'ın `set_compact_limit` frame'i
  (`session.ts:505-508`, `session.ts:2458`). Varsayılan `0` = kapalı.

### 2. Hardcoded varsayılanlar gerçek modelle uyuşmuyor

- `app/renderer/modules/state.js:129` — UI varsayılanı `compactLimit: 1024000`.
  32k'lık bir lokal modelde bu eşiğe asla ulaşılmaz, yani auto-compact hiç tetiklenmez.
- `app/renderer/index.html:312` — aynı sabit `value="1024000"` olarak formda da duruyor.
- `tui/src/**` `set_compact_limit` frame'ini **hiç göndermiyor** → TUI ve headless
  kullanımda auto-compaction tamamen kapalı, yalnızca elle `/compact` çalışıyor.

### 3. Context taşması "çıktı kesilmesi" sanılıyor — döngüyü besleyen hata

- `engine/providers/src/openai-compat.ts:430` (`TRUNCATION_REASONS`) ve
  `engine/providers/src/anthropic.ts:155` (`mapStop`), `model_context_window_exceeded`
  değerini `"max_tokens"`e map ediyor.
- `session.ts:1496` (LAYER 3) bunu görünce `LENGTH_CONTINUATION_TEXT` mesajını
  **geçmişe ekleyip** döngüye devam ediyor. Yani context taşmasına verilen yanıt,
  context'i biraz daha büyütmek oluyor.

### 4. İki cutoff emit noktası var; biri sınırsız

- Site A — `session.ts:1498`, metin yolu. `nudgeCount < MAX_AUTO_NUDGES` (3) ile sınırlı.
- Site B — `session.ts:1678`, tool_call'lu kesilme yolu. **Sayaç yok, sınır yok**;
  `stopReason === "max_tokens"` olduğu her iterasyonda basılıyor. Transkriptte görülen
  tekrar bu.
- Site B ayrıca `TOOL_CUTOFF_TEXT` sonucunu `isError: true` üretiyor → `lastBatchHadError`
  true oluyor → LAYER 2 nudge'ı da aynı 3'lük bütçeden harcanıyor.
- `nudgeCount` üç rung arasında **paylaşımlı** (LAYER 3 kesilme, LAYER 2 hata kurtarma,
  LAYER 1 wrap-up), bu yüzden hata kurtarmaya harcanan nudge, kesilen yanıtı sürdürmek
  için kalan bütçeyi azaltıyor.

### 5. Bütçe bitince sessiz `break`

- `session.ts:1670` — hiçbir şey emit etmeden `break`. Alttaki her rung
  `stopReason === "end_turn"` istediği için `max_tokens` (ve `refusal`) hiçbirine uymuyor.
- Kullanıcıya kalan tek iz: `turn_finished.stopReason: "max_tokens"`.
  - `tui/src/components/TranscriptLine.tsx:266` bunu **başarı glifiyle** `✓ max_tokens`
    diye gösteriyor.
  - `app/renderer/modules/stream.js:305-326` "hit the response length limit" yazıyor.

### 6. Asıl "sessiz patlama"

- `engine/providers/src/openai-compat.ts:221` — SSE gövdesi içinde gelen
  `{"error":{...}}` chunk'ında `choices` alanı yok; `handleChunk` sessizce `return`
  ediyor. Stream `mapFinish(undefined)` = `end_turn` ve sıfır usage ile bitiyor.
  **Hiç `error` olayı yok, stderr satırı yok, boş asistan mesajıyla tur temiz görünüyor.**
  Birçok gateway context taşmasını tam olarak bu biçimde bildiriyor.
- HTTP 400 yolunda ise: `retry.ts:71` doğru şekilde 400'ü retry etmiyor, ama
  `friendlyProviderError` (`retry.ts:97-135`) 401/403/404/429/408/504/5xx dallarına
  sahipken **400 ve 413 dalı yok** → kullanıcı ham `provider returned 400: {...}`
  metnini görüyor, `/compact` ya da limit düşürme önerisi almıyor.
- `openai-compat.ts:78` — gövdede `max_tokens` geçen ve `invalid` içeren bir 400
  (ör. "max_tokens is too large") yanlışlıkla "sunucu `max_tokens` alan adını
  reddetti" diye okunuyor; alan kalıcı olarak `max_completion_tokens`e çevriliyor.

### 7. Yardımcı çağrılar hataları tamamen yutuyor

- Clarify ön katmanı `session.ts:1180` → `catch { return undefined; }`
- Otomatik isimlendirme `session.ts:2421` → `catch { ... return undefined; }`
- Model kataloğu `engine.ts:267` → `.catch(() => {})`
- SessionStart hook `engine.ts:318` → `.catch(() => {})`

Bu çağrılardaki bir context-overflow 400'ü ya da 401 hiçbir iz bırakmıyor.

### 8. Alt-ajan hataları başarı gibi raporlanıyor

- `Session.runTurn` her şeyi kendi içinde yakaladığı için (`session.ts:1737`) throw etmiyor.
- `spawnAgent`in `catch`i (`session.ts:1035`) hiç ateşlenmiyor, `failed` false kalıyor,
  `agent_finished` **`isError` olmadan** yayılıyor (`session.ts:1041`) ve orkestratöre
  boş/kısmi metin başarılı sonuç gibi dönüyor.

## Doküman / kod çelişkileri

- `docs/SETTINGS.md:78` `compactionThreshold: 0.8` anahtarını belgeliyor —
  bu anahtar **şemada yok** (`engine/core/src/config/settings.ts`), yazılırsa
  `loadSettings` "unknown key" uyarısı veriyor.
- `docs/query-lifecycle.html` "MAX_AUTO_NUDGES artık yalnızca wrap-up nudge'ını
  sınırlıyor" diyor; kod LAYER 3'ü de aynı sayaçla sınırlıyor.
- `docs/LOCAL-MODELS.md:35-51,73` "Context size alanı Magentra'nın compaction
  penceresi olur" diyor — mevcut kodda doğru değil, o alan yalnızca `num_ctx` ve
  uyarı metni için kullanılıyor.
- `engine/protocol/src/types.ts:253` `contextWarn`i "~200k, model penceresinin altında
  kırpılmış" diye belgeliyor; gerçek uygulama `0.9 * autoCompactLimit`.
- `engine/` altında **hiç test dosyası yok**.

## Düzeltme yönü (karar verilmedi)

Yeni fonksiyon gerekmiyor; mevcut olanları geliştirmek yeterli görünüyor:

1. `MODEL_CONTEXT_WINDOWS` tablosunu doldur (veri, kod değil).
2. `maybeCompact()` / `setAutoCompactLimit()`: açık bir kullanıcı değeri yoksa limiti
   `contextWindowFor(model, settings)` üzerinden türet. Sabit sayı hiçbir yerde kalmasın.
3. `compactionThreshold` anahtarını `settingsSchema`'ya ekle (dokümanda zaten var).
4. `app/renderer/modules/state.js` + `index.html`: `1024000` sabitini "auto"ya çevir.
   Dikkat: `CONTEXT.md`'deki **Additive-Only State** kuralı, `compactLimit: 0`'ın
   anlamını "kapalı"dan "auto"ya çevirmeyi yasaklıyor — yeni bir anahtar gerekir.
5. `tui/src`: TUI'nin de limiti bildirmesi ya da motorun kendi türetmesi.
6. Site B'yi (`session.ts:1678`) Site A ile aynı bütçeye bağla; bütçe bitince
   `session.ts:1670`'teki `break` sessiz olmasın, görünür bir sebep bassın.
7. `model_context_window_exceeded`i `max_tokens`ten ayır — bu bir çıktı kesilmesi değil,
   girdi taşması; yanıtı "devam et" değil, "compact et" olmalı.
8. `openai-compat.ts:221`'de gövde içi `{"error":...}` chunk'ını tanı ve yay.
9. `friendlyProviderError`e 400/413 dalı ekle, `/compact` önerisiyle.

## Açık kalan sorular

- Hardcoded limit hangi koşulda kullanıcıya bırakılsın? ("kullanıcı özellikle ___"
  cümlesi tamamlanmadı.)
- Kapsam: yalnızca context/compact tarafı mı, dört arıza yolunun hepsi mi?
- Katman: yalnızca `engine/core` mü, yoksa `app/renderer` ve `tui/src` de dahil mi?
