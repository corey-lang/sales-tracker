// ~210 motivational / sales / mindset quotes. Add or trim as desired.
const QUOTES = [
  "The harder you work, the luckier you get.",
  "Every no gets you closer to a yes.",
  "Make today count.",
  "Your attitude determines your altitude.",
  "Success is the sum of small efforts repeated daily.",
  "Don't wait for opportunity. Create it.",
  "Champions train. Others complain.",
  "The best preparation for tomorrow is doing your best today.",
  "Hustle beats talent when talent doesn't hustle.",
  "Sell yourself before you sell your product.",
  "Persistence is the twin of excellence.",
  "Always be closing. Always be learning.",
  "Outwork your potential.",
  "One conversation can change everything.",
  "Show up and good things happen.",
  "Effort beats luck.",
  "Be the salesperson you'd want to buy from.",
  "Pick up the phone. The rest takes care of itself.",
  "You miss 100% of the calls you don't make.",
  "Treat every customer like your only customer.",
  "Confidence is the closer's secret weapon.",
  "Today's hustle is tomorrow's win.",
  "Move fast, finish strong.",
  "Don't dream of selling. Sell.",
  "Curiosity is your best sales tool.",
  "Listen twice. Pitch once.",
  "The quota is just a starting line.",
  "Action cures fear.",
  "Practice makes perfect calls.",
  "Trust is your most valuable product.",
  "Discipline equals freedom.",
  "Small wins compound.",
  "Done is better than perfect.",
  "Hard work has no shortcuts.",
  "Today's effort is tomorrow's reward.",
  "Start before you're ready.",
  "Better than yesterday.",
  "Progress, not perfection.",
  "Focus is a superpower.",
  "Show up even when you don't feel like it.",
  "Your future is built on today.",
  "Tough times build tougher people.",
  "Stay hungry, stay humble.",
  "Action over excuses.",
  "Be the energy you want to attract.",
  "Difficult roads lead to beautiful destinations.",
  "What you do today determines what tomorrow looks like.",
  "Make your move.",
  "Don't count the days, make the days count.",
  "Excellence is a habit, not an act.",
  "The expert in anything was once a beginner.",
  "Grow through what you go through.",
  "If it doesn't challenge you, it doesn't change you.",
  "Stay focused, stay positive, stay grinding.",
  "The grind is undefeated.",
  "Hard work in silence, let success make the noise.",
  "Your only competition is yesterday's you.",
  "Be patient. Trust the process.",
  "Greatness lives just outside your comfort zone.",
  "Dreams don't work unless you do.",
  "If not now, when?",
  "Stay positive. Work hard. Make it happen.",
  "Some days you have to create your own sunshine.",
  "Quitting is permanent. Pain is temporary.",
  "Make it happen. Shock everyone.",
  "Pressure makes diamonds.",
  "Believe you can and you're halfway there.",
  "The only bad workout is the one that didn't happen.",
  "Push yourself. No one else is going to do it for you.",
  "Strive for progress, not perfection.",
  "Fall seven times, stand up eight.",
  "Persistence beats resistance.",
  "Keep going. You're closer than you think.",
  "Don't stop when you're tired. Stop when you're done.",
  "The road to success is always under construction.",
  "Your only limit is the one you set yourself.",
  "Persistence pays.",
  "The path is the goal.",
  "Stay the course.",
  "Tough situations build strong people.",
  "What matters most is how well you walk through the fire.",
  "Be stubborn about your goals, flexible about your methods.",
  "Failure is just a lesson in disguise.",
  "Comebacks are stronger than setbacks.",
  "Quitters never win.",
  "Inch by inch, anything's a cinch.",
  "Slow progress is still progress.",
  "Don't give up. Don't ever give up.",
  "Tough times never last. Tough people do.",
  "Discipline is doing what needs to be done even when you don't want to do it.",
  "Action conquers fear.",
  "Do something today that your future self will thank you for.",
  "Champions keep playing until they get it right.",
  "Trying times are not the times to stop trying.",
  "When you feel like quitting, think about why you started.",
  "Persistence is a long-distance runner.",
  "Energy and persistence conquer all things.",
  "You can't always control what happens, but you can control how you respond.",
  "Don't watch the clock. Do what it does. Keep going.",
  "The reason most goals are not achieved is that we spend our time doing second things first.",
  "Be so good they can't ignore you.",
  "Greatness begins beyond your comfort zone.",
  "If you can dream it, you can do it.",
  "Don't be afraid to give up the good to go for the great.",
  "Stop being afraid of what could go wrong and start being excited about what could go right.",
  "Today is the perfect day to start.",
  "Wake up with determination. Go to bed with satisfaction.",
  "Your work is going to fill a large part of your life. Make it count.",
  "Quality is not an act. It is a habit.",
  "Hard work + dedication = success.",
  "The only person you should try to be better than is the person you were yesterday.",
  "If opportunity doesn't knock, build a door.",
  "Talent wins games. Teamwork wins championships.",
  "Success doesn't come to you, you go to it.",
  "Confidence comes from preparation.",
  "Doubts kill more dreams than failure ever will.",
  "Always do your best. What you plant now, you will harvest later.",
  "Sometimes later becomes never. Do it now.",
  "Stay close to anything that makes you glad you are alive.",
  "You don't have to be perfect to be amazing.",
  "Big results require big ambition.",
  "Don't be afraid to fail. Be afraid not to try.",
  "Believe in yourself and all that you are.",
  "Success is not final; failure is not fatal.",
  "Either you run the day or the day runs you.",
  "Do or do not. There is no try.",
  "Mistakes are proof that you're trying.",
  "Whatever you are, be a good one.",
  "Dream big and dare to fail.",
  "Don't let yesterday take up too much of today.",
  "Stay foolish, stay hungry.",
  "The only way to do great work is to love what you do.",
  "Innovation distinguishes between a leader and a follower.",
  "Get busy living or get busy dying.",
  "Don't be pushed around by the fears in your mind.",
  "Aim for the moon. If you miss, you may hit a star.",
  "Set your standards high and don't settle for less.",
  "Be brave. Take risks. Nothing can substitute experience.",
  "You are never too old to set another goal.",
  "Try not to become a person of success, but rather a person of value.",
  "Whatever you can do or dream you can, begin it.",
  "All progress takes place outside the comfort zone.",
  "What we fear doing most is usually what we most need to do.",
  "The man who has confidence in himself gains the confidence of others.",
  "There are no shortcuts to any place worth going.",
  "Start where you are. Use what you have. Do what you can.",
  "You don't have to see the whole staircase, just take the first step.",
  "Be the hardest worker in the room.",
  "Winners focus on winning. Losers focus on winners.",
  "Discipline is the bridge between goals and accomplishment.",
  "The way to get started is to quit talking and begin doing.",
  "Don't tell people your plans. Show them your results.",
  "Be brave enough to be bad at something new.",
  "Work hard in silence. Let success be your noise.",
  "If you're not making mistakes, you're not trying hard enough.",
  "Don't be busy, be productive.",
  "Make excellence your standard.",
  "Eyes on the prize.",
  "Show up. Stand out.",
  "Be the change you want to see.",
  "Mood follows action.",
  "Make momentum your friend.",
  "Choose effort over comfort.",
  "Action absorbs anxiety.",
  "Earn it every day.",
  "Lead with curiosity.",
  "You miss the shots you don't take.",
  "Compete with yourself.",
  "Embrace the suck.",
  "Adversity introduces a man to himself.",
  "Master the basics.",
  "Reps build legends.",
  "Win the morning, win the day.",
  "Eat the frog first.",
  "Don't break the chain.",
  "Aim small, miss small.",
  "Speed is a skill.",
  "Energy management beats time management.",
  "Be unreasonable.",
  "Excellence is in the details.",
  "Doing nothing is worse than failing.",
  "Brave first. Polished later.",
  "Trade comfort for growth.",
  "Done beats perfect.",
  "Show up early. Stay late.",
  "Sweat the prep.",
  "Don't quit on a bad day.",
  "Be relentless about the right things.",
  "Today is the field.",
  "Effort is the equalizer.",
  "Make calls before checking email.",
  "Practice in the dark to shine in the light.",
  "Hard things first.",
  "Get one percent better today.",
  "Volume solves a lot of problems.",
  "Stay coachable.",
  "Be specific about what you want.",
  "Write the goal down.",
  "Track what matters.",
  "Tiny gains, big wins.",
  "Pressure is a privilege.",
  "Hard work pays. Period.",
  "Take the meeting.",
  "Don't argue with the customer's pain — solve it.",
  "Today is recruit day for your future.",
  "Be the reason someone smiles today.",
  "If it's important, find a way.",
  "Show up like you mean it.",
  "Habit makes the hero.",
  "Tomorrow's you is watching.",
];

const SEEN_KEY = "sales-tracker:quotes-seen-v2";
const COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

type SeenMap = Record<string, number>; // index (as string) → timestamp ms

function loadSeen(): SeenMap {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== "object") return {};
    const out: SeenMap = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === "number") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveSeen(seen: SeenMap) {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // localStorage unavailable or quota-exceeded — silently ignore.
  }
}

// Returns a quote whose last appearance was more than 30 days ago (or never).
// If every quote was shown in the last 30 days, falls back to the one seen
// longest ago.
export function nextQuote(): string {
  if (QUOTES.length === 0) return "";
  const seen = loadSeen();
  const now = Date.now();

  const eligible: number[] = [];
  for (let i = 0; i < QUOTES.length; i++) {
    const last = seen[String(i)];
    if (last === undefined || now - last > COOLDOWN_MS) {
      eligible.push(i);
    }
  }

  let idx: number;
  if (eligible.length > 0) {
    idx = eligible[Math.floor(Math.random() * eligible.length)];
  } else {
    let oldestIdx = 0;
    let oldestTs = Number.POSITIVE_INFINITY;
    for (let i = 0; i < QUOTES.length; i++) {
      const t = seen[String(i)] ?? 0;
      if (t < oldestTs) {
        oldestTs = t;
        oldestIdx = i;
      }
    }
    idx = oldestIdx;
  }

  seen[String(idx)] = now;
  saveSeen(seen);
  return QUOTES[idx];
}
