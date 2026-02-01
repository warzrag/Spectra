import {
  Fingerprint,
  Users,
  Globe,
  Shield,
  Puzzle,
  FileJson,
} from 'lucide-react';

const features = [
  {
    icon: Fingerprint,
    title: 'Unique Fingerprints',
    description:
      'Canvas, WebGL, Audio noise, and WebRTC control. Each profile gets a completely unique browser fingerprint.',
  },
  {
    icon: Users,
    title: 'Multi-Profile Management',
    description:
      'Organize profiles in folders with tags and platform targeting. Twitter, Instagram, TikTok, and more.',
  },
  {
    icon: Globe,
    title: 'Proxy Integration',
    description:
      'HTTP, HTTPS, and SOCKS5 proxy support with automatic rotation, health checks, and provider integrations.',
  },
  {
    icon: Shield,
    title: 'Team Collaboration',
    description:
      'Admin and VA roles with profile assignment, activity logs, and real-time cloud sync across devices.',
  },
  {
    icon: Puzzle,
    title: 'Extension Support',
    description:
      'Load Chrome extensions into any profile. Install from ZIP or folder, enable per-profile.',
  },
  {
    icon: FileJson,
    title: 'Cookie Management',
    description:
      'Import and export cookies in JSON or Netscape format. Pre-load sessions for instant access.',
  },
];

export default function Features() {
  return (
    <section id="features" className="py-24">
      <div className="max-w-6xl mx-auto px-6">
        <div className="text-center">
          <h2 className="text-3xl md:text-4xl font-bold text-[#f0f0f5]">
            Everything you need
          </h2>
          <p className="text-[#8b8b9e] text-lg mt-4">
            Powerful tools for managing multiple browser identities
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mt-16">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="feature-card rounded-2xl p-8"
              style={{
                backgroundColor: '#0f0f17',
                border: '1px solid rgba(255, 255, 255, 0.06)',
              }}
            >
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center"
                style={{ backgroundColor: 'rgba(99, 102, 241, 0.1)' }}
              >
                <feature.icon className="w-6 h-6" style={{ color: '#818cf8' }} />
              </div>
              <h3 className="text-lg font-semibold text-[#f0f0f5] mt-5">
                {feature.title}
              </h3>
              <p className="text-sm text-[#8b8b9e] mt-2 leading-relaxed">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
