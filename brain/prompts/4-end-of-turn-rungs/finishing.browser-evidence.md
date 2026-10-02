---
id: finishing.browser-evidence
group: 4 · End-of-turn rungs
label: Browser evidence rung
channel: reminder
where: Fires once at the end of a turn that changed a browser-facing file (.html, .css, a component) and never drove a browser or read a screenshot. Shares the runtime-evidence fuse, so at most one of the two fires per turn. Costs at least one extra round trip.
placeholders: files, visionNote
---
<system-reminder>You changed what the user sees ({{files}}) and checked it only from the outside — commands, HTTP requests, syntax checks. Nothing has been observed in a browser, where the user will use it, and a page can load with HTTP 200 and still not work.

Before you call it done:
1. Open it the way the user will: drive the page in a real or headless browser — for example a short Playwright or Puppeteer script in the system temp directory, deleted in this same turn. Load it, do each main thing the user asked for with the default settings, and read what happens: the rendered text, the DOM, the console errors.
2. {{visionNote}}
3. Check that the user can tell what happened: every action they take gets visible feedback, and every rule they need is on the screen, not only in your answer.
4. Say in your wrap-up what you drove in the browser and what you observed.

If no browser can run on this machine, STOP HERE AND SAY SO: name what you checked instead and say plainly that the page itself stays unverified. That is a complete and correct answer.</system-reminder>
