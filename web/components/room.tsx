// Who is in the room (DESIGN section 6.1): the two sides, made explicit and human. The people
// are drawn like the figures on an architect's elevation: fine lines, no faces, the same hand as
// the specimen. Only the heatsink has a face on this site.

function Buyer() {
  return (
    <svg className="people" viewBox="0 0 320 150" role="img" aria-label="A person seated at a desk with a screen; on the screen, two agents' bids, each marked with a solid blue square.">
      <line x1="8" x2="312" y1="140" y2="140" className="thin" />
      {/* Desk and screen */}
      <path d="M126 96H262M134 96V140M254 96V140" className="line" />
      <rect x="168" y="40" width="80" height="50" rx="3" className="screen" />
      <path d="M204 90V96M194 96H218" className="line" />
      <rect x="176" y="50" width="6" height="6" rx="1" className="led-on" />
      <path d="M187 53H232" className="thin" />
      <rect x="176" y="62" width="6" height="6" rx="1" className="led-on" />
      <path d="M187 65H222" className="thin" />
      <path d="M176 78H240" className="thin" strokeDasharray="2 2" />
      <text x="176" y="34">AGENT · BID ONLY</text>
      {/* Chair */}
      <path d="M66 102H104M70 102L64 60M72 102L70 140M100 102L104 140" className="line" />
      {/* The person, seated, one forearm on the desk */}
      <circle cx="94" cy="38" r="9" className="fig" />
      <path d="M82 52Q94 46 106 53L108 99H80Z" className="fig" />
      <path d="M100 58L126 82L156 90" className="line" />
      <path d="M80 96H122V105H82Z" className="fig" />
      <path d="M114 105H122V137H114Z" className="fig" />
      <path d="M114 137H130V140H114Z" className="solid" />
      <text x="8" y="16">TEAM + AGENTS · LONG</text>
    </svg>
  );
}

function Seller() {
  return (
    <svg className="people" viewBox="0 0 320 150" role="img" aria-label="A person standing at a server rack, sliding out one tray; each tray has gold lights.">
      <line x1="8" x2="312" y1="140" y2="140" className="thin" />
      {/* The rack: six trays, each with a vent and two lights */}
      <rect x="186" y="14" width="84" height="126" rx="2" className="fig" />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <g key={i}>
          <rect x={i === 3 ? 176 : 192} y={22 + i * 19} width="72" height="14" rx="1" className="fig" />
          <path d={`M${(i === 3 ? 176 : 192) + 22} ${26 + i * 19}V${32 + i * 19}M${(i === 3 ? 176 : 192) + 26} ${26 + i * 19}V${32 + i * 19}M${(i === 3 ? 176 : 192) + 30} ${26 + i * 19}V${32 + i * 19}M${(i === 3 ? 176 : 192) + 34} ${26 + i * 19}V${32 + i * 19}`} className="thin" />
          <rect x={(i === 3 ? 176 : 192) + 56} y={27 + i * 19} width="4" height="4" rx="0.6" className="led-gold" />
          <rect x={(i === 3 ? 176 : 192) + 62} y={27 + i * 19} width="4" height="4" rx="0.6" className="led-gold" />
        </g>
      ))}
      {/* The person, standing, a hand on the open tray */}
      <circle cx="134" cy="30" r="9" className="fig" />
      <path d="M121 44Q134 39 147 45L145 92H125Z" className="fig" />
      <path d="M144 50L160 72L176 83" className="line" />
      <path d="M124 50L119 88" className="line" />
      <path d="M126 92H134V137H126Z" className="fig" />
      <path d="M136 92H144V137H136Z" className="fig" />
      <path d="M124 137H136V140H124ZM136 137H148V140H136Z" className="solid" />
      <text x="8" y="16">GPU OWNER · SHORT</text>
    </svg>
  );
}

export function Room() {
  return (
    <div className="room">
      <article className="side-card">
        <Buyer />
        <span className="side-who L">
          <i aria-hidden="true" /> Buyers hold LONG
        </span>
        <h3>People who need GPU time next week</h3>
        <p>
          <b>AI teams, and the agents they run.</b> LONG pays out more the higher next week&rsquo;s average GPU-hour price, up to the band, so a rise in what compute costs is met by the hedge.
        </p>
        <p className="small">An agent bids with a key that can commit and reveal, and can never withdraw.</p>
      </article>
      <article className="side-card">
        <Seller />
        <span className="side-who S">
          <i aria-hidden="true" /> Sellers hold SHORT
        </span>
        <h3>People who own the GPUs</h3>
        <p>
          <b>Neoclouds, labs with spare racks, data centres.</b> SHORT pays out more the lower next week&rsquo;s average price, down to the floor, so a fall in what their hours earn is met by the hedge.
        </p>
        <p className="small">Both sides lock their whole worst case when the position opens. Nobody owes more later, so nothing is liquidated.</p>
      </article>
    </div>
  );
}
