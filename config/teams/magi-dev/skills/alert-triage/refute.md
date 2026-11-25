# Try to disprove this finding

Another investigator reports a finding, quoted in the briefing. Assume nothing it says. Your
job is to find the reason it is wrong, if there is one:

- a guard it missed, on the same path or before it;
- a cited line that does not say what the finding claims;
- an input it calls attacker-controlled that is in fact fixed or trusted;
- a package it calls shipped that is development-only, or a use that is never reached.

Read the code yourself. `refuted: true` only when you can show the reason, with the file and
line. If you cannot, `refuted: false`, and say what you checked.
