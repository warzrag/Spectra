export default function Hero() {
  return (
    <section id="hero" className="relative overflow-hidden pt-32 pb-20">
      {/* Background glow orbs */}
      <div className="hero-glow hero-glow-1" />
      <div className="hero-glow hero-glow-2" />

      {/* Content */}
      <div className="relative z-10 text-center max-w-4xl mx-auto px-6">
        {/* Badge */}
        <div className="inline-flex items-center mb-8">
          <span
            className="text-sm font-medium px-4 py-1.5 rounded-full"
            style={{
              background: "rgba(99, 102, 241, 0.1)",
              color: "#818cf8",
              border: "1px solid rgba(99, 102, 241, 0.2)",
            }}
          >
            v1.5 — Free to use
          </span>
        </div>

        {/* Title */}
        <h1 className="text-5xl md:text-7xl font-black tracking-tight bg-gradient-to-b from-white to-[#8b8b9e] bg-clip-text text-transparent">
          The Next-Gen
          <br />
          Antidetect Browser
        </h1>

        {/* Subtitle */}
        <p className="text-lg text-[#8b8b9e] max-w-2xl mx-auto mt-6 leading-relaxed">
          Manage multiple browser profiles with unique fingerprints. Advanced
          anti-detection, proxy integration, and team collaboration — all in one
          app.
        </p>

        {/* Buttons */}
        <div className="flex flex-wrap gap-4 justify-center mt-10">
          <a
            href="/signup"
            className="flex items-center gap-2 px-8 py-4 rounded-xl text-white font-semibold bg-gradient-to-r from-[#6366f1] to-[#7c3aed] shadow-lg shadow-indigo-500/25 hover:scale-105 transition-transform duration-200 cursor-pointer"
          >
            Get Started
          </a>
        </div>

        {/* Platform note */}
        <p className="text-sm text-[#8b8b9e] mt-4">
          Invite code required
        </p>
      </div>
    </section>
  );
}
