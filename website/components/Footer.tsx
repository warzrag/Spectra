import { Shield, Twitter } from "lucide-react";

const productLinks = [
  { label: "Features", href: "#features" },
  { label: "Pricing", href: "#pricing" },
  { label: "Get Started", href: "/signup" },
];

const resourceLinks = [
  { label: "Documentation", href: "#" },
  { label: "API Reference", href: "#" },
  { label: "Community", href: "#" },
  { label: "Support", href: "#" },
];

const legalLinks = [
  { label: "Privacy Policy", href: "#" },
  { label: "Terms of Service", href: "#" },
  { label: "Cookie Policy", href: "#" },
];

const socialLinks = [
  { icon: Twitter, href: "#", label: "Twitter" },
];

export default function Footer() {
  return (
    <footer
      className="border-t border-white/[0.06]"
      style={{ backgroundColor: "#06060b" }}
    >
      <div className="mx-auto max-w-6xl px-6 py-16">
        {/* Top section */}
        <div className="grid grid-cols-1 gap-12 md:grid-cols-4">
          {/* Brand column */}
          <div>
            <a href="#" className="flex items-center gap-2.5">
              <div
                className="flex h-8 w-8 items-center justify-center rounded-lg"
                style={{
                  background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
                }}
              >
                <Shield size={22} className="text-white" strokeWidth={2.2} />
              </div>
              <span
                className="font-bold text-white"
                style={{ fontSize: "18px" }}
              >
                Spectra
              </span>
            </a>
            <p className="mt-4 max-w-xs text-sm text-[#8b8b9e]">
              The next-gen antidetect browser for professionals.
            </p>
          </div>

          {/* Product column */}
          <div>
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-[#f0f0f5]">
              Product
            </h3>
            {productLinks.map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="mb-3 block text-sm text-[#8b8b9e] transition hover:text-[#f0f0f5]"
              >
                {link.label}
              </a>
            ))}
          </div>

          {/* Resources column */}
          <div>
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-[#f0f0f5]">
              Resources
            </h3>
            {resourceLinks.map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="mb-3 block text-sm text-[#8b8b9e] transition hover:text-[#f0f0f5]"
              >
                {link.label}
              </a>
            ))}
          </div>

          {/* Legal column */}
          <div>
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-[#f0f0f5]">
              Legal
            </h3>
            {legalLinks.map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="mb-3 block text-sm text-[#8b8b9e] transition hover:text-[#f0f0f5]"
              >
                {link.label}
              </a>
            ))}
          </div>
        </div>

        {/* Bottom section */}
        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-white/[0.06] pt-8 md:flex-row">
          <p className="text-sm text-[#8b8b9e]">
            &copy; 2025 Spectra. All rights reserved.
          </p>
          <div className="flex gap-4">
            {socialLinks.map((social) => (
              <a
                key={social.label}
                href={social.href}
                className="text-[#8b8b9e] transition hover:text-[#f0f0f5]"
                aria-label={social.label}
              >
                <social.icon size={18} />
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
