# Before charging anyone

A pilot at your own workplace and a paying customer are different things.
This is what changes between them.

---

## Legal and financial — do these first

**Form the LLC.** Arkansas filing is inexpensive and can be done online.
Until then, a customer with a complaint is suing *you*, personally.

**Get an EIN** from the IRS. Free, takes minutes, needed for a business
bank account.

**Open a business bank account.** Never run customer money through a
personal account — it undermines the liability protection the LLC exists
to give you.

**General liability insurance**, and ask specifically about **technology
errors & omissions**. You're touching systems a business relies on for
security. If your software misses an incident, or a camera gets
misconfigured, "I'm just a guy with a script" is not a defence.

**Terms of Service and a Privacy Policy** on the site. You handle images of
members. At minimum: what you collect, how long you keep it, who can see
it, what you don't do (no facial recognition, no identification), and that
you disclaim responsibility for security outcomes.

**A Data Processing Agreement** with each gym. They are the data
controller, you are the processor. It should say they're responsible for
telling their members cameras are monitored, because they are.

---

## Product gaps that become real once money changes hands

**You cannot say "unscanned".** You can say "more people crossed than
expected." That is an honest and useful claim; the other one isn't yours to
make until you integrate with a check-in system. Don't let it drift in
conversation.

**No SLA, no uptime guarantee, no support hours beyond your own.** Say so
plainly rather than leaving it implied.

**One person.** If you're unreachable for a week, nobody covers. Customers
should know that going in — it's fine at this size if it's stated.

**The alert log holds 48 hours.** Flagged events survive 35 days for the
monthly report. If a customer expects a year of history, that's a
conversation before signing, not after.

**Stripe is in test mode.** Nothing connects to a bank yet.

---

## The employer conversation

You're running this at your workplace. Configuring the system is not the
same as running a business on it, and the gap between those is where
problems live.

Have the conversation before there's a second customer. It goes better as
*"I built this, it's been running on our door for a week, here's what it
found, I'd like to make it a product"* than as something discovered later.

Get whatever you agree in writing, even informally. Especially if J Street
becomes a paying customer — you'd be selling to your own employer, and that
needs to be clean.

---

## Before the first invoice

- [ ] LLC formed, EIN issued, business bank account open
- [ ] Liability + tech E&O insurance quoted and bought
- [ ] ToS, Privacy Policy, DPA on the site and signed
- [ ] Stripe live, tested with a real card, refund path known
- [ ] Written agreement with your employer
- [ ] Two weeks of pilot data proving it actually catches things
- [ ] A written answer to "what do we do with a 3am alert?"
- [ ] Someone other than you has read the code
- [ ] You know your real monthly cost per gym

---

## The one to be honest with yourself about

You have not yet proven the product catches real tailgating at a real
turnstile. You've proven it runs. Those are different, and only the pilot
data tells you which you have.

If a fortnight of logs shows it catching things staff genuinely didn't
know about, you have a business. If it shows mostly noise, you have more
tuning to do — and that is a much better thing to learn now than after
someone has paid.
