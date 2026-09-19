I'm sharing a small free tool: Jevaluate.

It lets a cheap AI click through your web app like a tester, and it stops and hands over to a person whenever it isn't sure.

Here it logs in, checks 4 pages, then stops at a page that doesn't exist.

[video: walk-watch.mp4]
---
The idea is simple. The AI (TypeSafe's Jev) never writes anything. It only picks from a short list, like "click Invoices" or "type the email", and says how sure it is.

Under 80% sure, it doesn't act. A person takes over.
---
Why trust that "how sure"? I tested it on 60 made-up requests in English and Arabic.

It got 10 wrong. All 10 times, it said it wasn't sure. Every time it said it was sure, it was right.

60 is a small test, so try it on your own app.
---
On each page it also takes one screenshot and asks a second AI that can see (DeepSeek) to look for visual problems.

On a demo app where I hid 3 on purpose, it found all 3: a button covering text, text too faint to read, and a leftover code label.

[image: walk-settings-defect.jpg]
---
The whole walk cost less than one cent.

It's free and open source (MIT): the scripts, a demo app you can run in a few minutes, and a skill for AI coding agents.

Built at Maykana with Claude. Thanks to @typesafeai for Jev.

If it's useful, a star helps others find it.
