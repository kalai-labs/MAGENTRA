# Context sınırına ulaşınca sessiz ölüm ve sonsuz "output-length cutoff" döngüsü

- **Durum:** ✅ Düzeltildi — 2026-09-01 (`research/lab-1`).
- **Tarih:** 2026-09-01
- **Branş:** `research/lab-1`
- **Nasıl görüldü:** Lokal bir modelle (Qwen 3.6 35B, OpenAI-uyumlu endpoint) uzun bir
  kod yazma turunda. Transkript `↻ continuing after output-length cutoff` satırını
  arka arkaya bastı, model her seferinde aynı dosyayı "sıfırdan yazıyorum" diyerek
  yeniden başlattı, sonunda tur görünür bir hata vermeden bitti.

## Ne yapıldı (özet)

İlke: **context penceresi tahmin edilmez, kullanıcı girer.** Bağlantı sihirbazındaki
CONTEXT SIZE alanı artık her bağlantı için (Ollama, LM Studio, hosted) zorunlu; motor bu
sayıdan kendi compaction limitini türetir ve pencere aşılırsa compact edip aynı çağrıyı
yeniden dener.

| # | Zincirdeki halka | Düzeltme | Dosya |
|---|---|---|---|
| 1 | Compaction limiti yalnızca UI'ın `set_compact_limit` frame'inden geliyordu (TUI/headless/alt-ajanlar: kapalı) | `Session.effectiveCompactLimit()` = `compactionThreshold × contextWindowFor(model, settings)`; UI frame'i artık yalnızca bir **tavan** (düşürür, yükseltemez; `0` = kapalı anlamını korur) | `engine/core/src/runtime/session.ts` |
| 2 | `compactionThreshold` dokümanda vardı, şemada yoktu | Şemaya eklendi (`0.8`, 0.1–1), `SETTING_TIMING`'e `nextTurn` | `engine/core/src/config/settings.ts`, `runtime/engine.ts` |
| 3 | Gate yalnızca son çağrının ölçülen girdisine bakıyordu; büyük tool sonuçları ölçümü geride bırakıyordu | Gate `max(ölçüm, estimateContextNow())` kullanır; çocuk oturum yalnızca kendi tahminine bakar (paylaşılan ledger kökün penceresidir) | `session.ts` `maybeCompact` |
| 4 | `model_context_window_exceeded` → `max_tokens` (çıktı kesilmesi sanılıyor, "devam et" ile context daha da büyüyordu) | Yeni `StopReason` `"context_overflow"`; oturum önce **zorla compact eder**, sonra kesilme olarak sürdürür | `engine/providers/src/{types,anthropic,openai-compat}.ts` |
| 5 | HTTP 400/413 context taşması turu bitiriyordu, ham `provider returned 400` metniyle | `isContextOverflowError()` / `looksLikeContextOverflow()` sınıflandırıcısı; oturum compact edip **aynı çağrıyı yeniden dener** (tur başına en fazla 2); `friendlyProviderError`'a overflow + 400/422 dalları | `engine/providers/src/retry.ts`, `session.ts` |
| 6 | 200 SSE akışı içindeki `{"error":…}` chunk'ı sessizce yutuluyordu → boş, "temiz" tur | `handleChunk` chunk'ı `ProviderHttpError` olarak fırlatır; `feed` bunu "bozuk satır" saymaz | `openai-compat.ts` |
| 7 | "max_tokens … invalid … exceed context" 400'ü alan reddi sanılıp `max_completion_tokens`'a çevriliyordu | `rejectedField` overflow metnini önce dışlar | `openai-compat.ts` |
| 8 | Site B (tool-call kesilmesi) sınırsızdı; Site A paylaşımlı `nudgeCount` kullanıyordu; bütçe bitince sessiz `break` | Kendi sayacı `cutoffStreak` (ardışık, tam yanıtta sıfırlanır, `MAX_CUTOFF_STREAK = 3`) iki site için de; aşılınca görünür `⏸ … cut off N times in a row` — tool yolunda sonuçlar push edildikten **sonra**, geçmiş hiçbir zaman sonuçsuz bir `tool_use` ile bitmez | `session.ts` |
| 9 | Motor başlangıcında "override < model/2" uyarısı boş tabloya karşı çalışıyordu | Yerine: `contextWindow` **yoksa** "128K varsayılıyor, sihirbazdan gir" uyarısı | `engine.ts` |
| 10 | Sihirbaz CONTEXT SIZE alanı yalnızca lokal preset'lerde görünüyor ve isteğe bağlıydı | Her preset'te görünür ve **zorunlu** (SAVE & CONNECT geçersiz/boşsa durur); payload'a her zaman eklenir | `app/renderer/index.html`, `modules/setup.js` |
| 11 | UI varsayılanı `compactLimit: 1024000` tek kaynaktı | Anlamı değişmedi (Additive-Only State): türetilen limite tavan; not metni güncellendi | `index.html`, `modules/state.js` |
| 12 | TUI `✓ max_tokens`; renderer'da `context_overflow` etiketi yoktu | TUI: temiz olmayan bitişte `✕` glifi; renderer: `context_overflow` etiketi | `tui/src/components/TranscriptLine.tsx`, `app/renderer/modules/stream.js` |

Doğrulama: `npm run build` temiz; yeni `.claude/skills/bigboycoding/compaction-check.mjs`
(23 senaryo, FakeProvider) — motor değişiklikleri stash'lenip çalıştırıldığında
başarısız, geri alınınca geçiyor; mevcut 5 check + `run-ui-tests.js` (32 senaryo) +
`window/connection/reasoning/vision` testleri geçiyor.

## Bilinçli olarak yapılmayanlar

- `app/main/connection.js` `validateCredentialPayload` **hâlâ** `contextWindow`'u isteğe
  bağlı kabul ediyor: alan zorunlu hale gelmeden önce kaydedilmiş profiller `USE` ile
  uygulanabilsin diye. Bu profiller motor başlangıcında "No context size is set…"
  uyarısını alır; sihirbazdan düzenlenip kaydedilince alan zorunlu.
- `MODEL_CONTEXT_WINDOWS` tablosu boş bırakıldı — pencere tahmin edilmez.
- Madde 7 (clarify / auto-name / katalog / hook `catch {}` yutmaları) ve madde 8
  (alt-ajan hatası `isError` olmadan `agent_finished`) bu kapsamda değil; ayrı iş.
- `docs/query-lifecycle.html` "MAX_AUTO_NUDGES yalnızca wrap-up'ı sınırlar" iddiası
  hâlâ LAYER 2 için yanlış (LAYER 3 artık kendi sayacında). Tarihsel doküman.

## Orijinal analiz (referans)

### Zincir

1. Context penceresi compaction'a bağlı değildi — `MODEL_CONTEXT_WINDOWS` boş,
   `contextWindowFor()` compaction yolunda hiç çağrılmıyordu, `maybeCompact()` yalnızca
   UI'dan gelen `autoCompactLimit`e bakıyordu (varsayılan 0 = kapalı).
2. UI varsayılanı `1024000`; TUI frame'i hiç göndermiyordu.
3. `model_context_window_exceeded` → `"max_tokens"` → `LENGTH_CONTINUATION_TEXT` eklenip
   context daha da büyütülüyordu.
4. İki cutoff emit noktası; tool-call yolu sınırsız; `nudgeCount` üç rung arasında paylaşımlı.
5. Bütçe bitince sessiz `break`; TUI `✓ max_tokens`.
6. SSE gövdesindeki `{"error":…}` chunk'ı `choices` olmadığı için yutuluyordu;
   `friendlyProviderError`'da 400/413 dalı yoktu; `max_tokens` içeren 400 alan reddi sanılıyordu.
7. Yardımcı çağrılar (`clarify`, auto-name, katalog, SessionStart hook) hataları yutuyor.
8. Alt-ajan hataları `isError` olmadan başarı gibi raporlanıyor.

### Doküman / kod çelişkileri (o günkü hali)

- `docs/SETTINGS.md` `compactionThreshold: 0.8` → şemada yoktu (**çözüldü**).
- `docs/LOCAL-MODELS.md` "Context size alanı compaction penceresi olur" → doğru değildi (**artık doğru**).
- `engine/protocol/src/types.ts` `contextWarn` "~200k" açıklaması (**güncellendi**).
- `docs/query-lifecycle.html` MAX_AUTO_NUDGES iddiası (kısmen; bkz. yukarı).
- `engine/` altında test yoktu → `compaction-check.mjs` eklendi.
