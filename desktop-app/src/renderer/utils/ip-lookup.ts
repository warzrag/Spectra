// Multiple IP lookup services for redundancy
const IP_SERVICES = [
  {
    url: (ip: string) => `https://ipapi.co/${ip}/json/`,
    parseResponse: (data: any) => ({
      ip: data.ip,
      city: data.city,
      region: data.region,
      country: data.country_name,
      isp: data.org || data.isp,
      lat: data.latitude,
      lon: data.longitude
    })
  },
  {
    url: (ip: string) => `http://ip-api.com/json/${ip}`,
    parseResponse: (data: any) => ({
      ip: data.query,
      city: data.city,
      region: data.regionName,
      country: data.country,
      isp: data.isp || data.org,
      lat: data.lat,
      lon: data.lon
    })
  },
  {
    url: (ip: string) => `https://ipinfo.io/${ip}/json`,
    parseResponse: (data: any) => ({
      ip: data.ip,
      city: data.city,
      region: data.region,
      country: data.country,
      isp: data.org,
      lat: parseFloat(data.loc?.split(',')[0] || '0'),
      lon: parseFloat(data.loc?.split(',')[1] || '0')
    })
  }
];

export async function lookupIP(ip: string): Promise<any> {
  for (const service of IP_SERVICES) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000); // 3 second timeout
      
      const response = await fetch(service.url(ip), {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      clearTimeout(timeout);
      
      if (response.ok) {
        const data = await response.json();
        return service.parseResponse(data);
      }
    } catch (error) {
      console.warn(`IP lookup failed with service:`, service.url(ip), error);
      continue; // Try next service
    }
  }
  
  // If all services fail, return basic info
  return {
    ip: ip,
    city: 'Unknown',
    region: 'Unknown',
    country: 'Unknown',
    isp: 'Unknown',
    lat: 0,
    lon: 0
  };
}

export function detectMobileISP(isp: string): boolean {
  if (!isp) return false;
  
  const mobileKeywords = [
    'mobile', 'cellular', 'wireless', 
    '4g', 'lte', '5g', '3g',
    'verizon', 'at&t', 'att', 't-mobile', 'sprint',
    'orange', 'vodafone', 'telefonica', 'movistar',
    'claro', 'tim', 'free mobile', 'sfr', 'bouygues',
    'o2', 'ee', 'three', 'telus', 'rogers', 'bell'
  ];
  
  const ispLower = isp.toLowerCase();
  return mobileKeywords.some(keyword => ispLower.includes(keyword));
}