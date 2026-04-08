/**
 * AgentCard — Animated ID-badge logo for Operation: Cluey.
 * Typewriter effect cycles through a pool of spy agents.
 */
import { useEffect, useRef, useState } from "react";
import spyImg from "../../assets/spy/spy-silhouette.svg";

const AGENT_POOL = [
  { name: "Viktor Ashford",   height: "6'1\"", dob: "12.03.1971", codename: "NIGHTOWL" },
  { name: "Lena Karova",      height: "5'7\"", dob: "28.09.1984", codename: "FOXGLOVE" },
  { name: "Marcus Hale",      height: "5'11\"",dob: "04.06.1968", codename: "IRONBARK" },
  { name: "Sable Reinhardt",  height: "5'9\"", dob: "17.11.1979", codename: "VELVET" },
  { name: "Oleg Petrov",      height: "6'3\"", dob: "22.01.1965", codename: "GREYWOLF" },
  { name: "Nina Strand",      height: "5'6\"", dob: "09.08.1990", codename: "MIRAGE" },
  { name: "Tobias Krug",      height: "5'10\"",dob: "30.05.1977", codename: "SPARROW" },
  { name: "Aria Montague",    height: "5'8\"", dob: "14.12.1982", codename: "PHANTOM" },
  { name: "Dimitri Volkov",   height: "6'2\"", dob: "03.04.1973", codename: "BLACKTHORN" },
  { name: "Elise Brenner",    height: "5'5\"", dob: "21.07.1988", codename: "ECLIPSE" },
];

const FIELDS = ["name", "height", "dob", "codename"];
const FIELD_LABELS = { name: "NAME", height: "HEIGHT", dob: "DOB", codename: "CODENAME" };

// Typing speed helpers (ms)
function typeDelay(char) {
  if (char === ".") return 280;
  if (char === " ") return 100;
  if (char === ",") return 200;
  // Base 55-110ms with occasional slower keystrokes
  return 55 + Math.random() * 55 + (Math.random() < 0.08 ? 120 : 0);
}

const DELETE_SPEED = 28;       // fast backspace
const FIELD_PAUSE = 320;       // pause between fields when typing
const HOLD_DURATION = 2800;    // how long the full card stays visible
const BETWEEN_AGENTS = 800;    // pause on empty card before next agent

/**
 * Flatten the agent's field values into a single sequence of steps.
 * Each step is { field, pos } where pos is how many chars of that field to show.
 * Between fields we insert a pause marker { pause: ms }.
 */
function buildTimeline(agent) {
  const steps = [];
  for (const key of FIELDS) {
    const val = agent[key];
    for (let i = 1; i <= val.length; i++) {
      steps.push({ field: key, pos: i, char: val[i - 1] });
    }
    steps.push({ pause: FIELD_PAUSE });
  }
  return steps;
}

export default function AgentCard({ className = "" }) {
  const [display, setDisplay] = useState({ name: "", height: "", dob: "", codename: "" });
  const [activeField, setActiveField] = useState(null);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    let agentIdx = Math.floor(Math.random() * AGENT_POOL.length);

    function wait(ms) {
      return new Promise((resolve) => {
        const id = setTimeout(resolve, ms);
        // Store for cleanup — we only need the latest
        cancelled._timeout = id;
      });
    }

    async function loop() {
      while (!cancelled.current) {
        const agent = AGENT_POOL[agentIdx];
        const timeline = buildTimeline(agent);

        // === TYPE phase ===
        const state = { name: "", height: "", dob: "", codename: "" };
        for (const step of timeline) {
          if (cancelled.current) return;
          if (step.pause) {
            await wait(step.pause);
            continue;
          }
          state[step.field] = agent[step.field].slice(0, step.pos);
          setActiveField(step.field);
          setDisplay({ ...state });
          await wait(typeDelay(step.char));
        }

        // === HOLD phase ===
        if (cancelled.current) return;
        setActiveField(null);
        await wait(HOLD_DURATION);

        // === DELETE phase — all fields in reverse order ===
        const allChars = [];
        for (const key of [...FIELDS].reverse()) {
          const val = state[key];
          for (let i = val.length - 1; i >= 0; i--) {
            allChars.push({ field: key, pos: i });
          }
        }
        for (const step of allChars) {
          if (cancelled.current) return;
          state[step.field] = state[step.field].slice(0, step.pos);
          setActiveField(step.field);
          setDisplay({ ...state });
          await wait(DELETE_SPEED + Math.random() * 12);
        }

        // === BETWEEN phase ===
        if (cancelled.current) return;
        setActiveField(null);
        await wait(BETWEEN_AGENTS);

        agentIdx = (agentIdx + 1) % AGENT_POOL.length;
      }
    }

    loop();

    return () => {
      cancelled.current = true;
      clearTimeout(cancelled._timeout);
    };
  }, []);

  return (
    <div className={`agent-card ${className}`}>
      <div className="agent-card__header">
        <span className="agent-card__op-label">OPERATION</span>
        <span className="agent-card__op-name">CLUEY</span>
      </div>

      <div className="agent-card__stripe" />

      <div className="agent-card__body">
        <div className="agent-card__photo">
          <img src={spyImg} alt="Agent silhouette" />
        </div>

        <div className="agent-card__info">
          <div className="agent-card__fields">
            {FIELDS.map((key) => (
              <div key={key} className="agent-card__field">
                <span className="agent-card__field-label">{FIELD_LABELS[key]}</span>
                <span className="agent-card__field-value">
                  {display[key]}
                  {activeField === key && <span className="agent-card__cursor" />}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="agent-card__classified">CLASSIFIED</div>
    </div>
  );
}
