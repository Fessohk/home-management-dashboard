import os
import requests
from datetime import datetime, timedelta
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.getenv("OCTOPUS_API_KEY")
MPAN = os.getenv("MPAN")
MPRN = os.getenv("MPRN")
ELEC_SERIAL = "Z17N039347"
GAS_SERIAL = "E6S11202861760"
ELEC_TARIFF = "E-1R-VAR-22-11-01-B"
GAS_TARIFF = "G-1R-VAR-22-11-01-B"

BASE_URL = "https://api.octopus.energy/v1"


def get_product_code(tariff_code):
    """Extract product code from tariff code e.g. E-1R-VAR-22-11-01-B -> VAR-22-11-01"""
    parts = tariff_code.split("-")
    return "-".join(parts[2:-1])


def get_unit_rate(meter_type, tariff_code):
    """Fetch current unit rate in p/kWh"""
    product_code = get_product_code(tariff_code)
    if meter_type == "electricity":
        url = f"{BASE_URL}/products/{product_code}/electricity-tariffs/{tariff_code}/standard-unit-rates/"
    else:
        url = f"{BASE_URL}/products/{product_code}/gas-tariffs/{tariff_code}/standard-unit-rates/"

    response = requests.get(url, auth=(API_KEY, ""))
    if response.status_code != 200:
        print(f"Error fetching {meter_type} rate: {response.status_code}")
        return None

    results = response.json().get("results", [])
    if not results:
        return None

    # Most recent rate is first
    rate_p = results[0]["value_inc_vat"]
    print(f"{meter_type.capitalize()} unit rate: {rate_p:.2f}p/kWh")
    return rate_p


def get_consumption(meter_type, reference, serial, days=30):
    """Fetch daily consumption for the last N days"""
    period_from = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%dT00:00:00Z")

    if meter_type == "electricity":
        url = f"{BASE_URL}/electricity-meter-points/{reference}/meters/{serial}/consumption/"
    else:
        url = f"{BASE_URL}/gas-meter-points/{reference}/meters/{serial}/consumption/"

    params = {
        "period_from": period_from,
        "page_size": 100,
        "group_by": "day",
        "order_by": "period"
    }

    response = requests.get(url, auth=(API_KEY, ""), params=params)
    if response.status_code != 200:
        print(f"Error fetching {meter_type} consumption: {response.status_code}")
        return []

    return response.json().get("results", [])


def m3_to_kwh(m3):
    """Convert gas cubic metres to kWh using standard UK conversion"""
    return m3 * 1.02264 * 39.2 / 3.6


def generate_html(elec_data, gas_data, elec_rate_p, gas_rate_p):
    """Build the dashboard HTML file"""

    # --- Process electricity ---
    elec_dates = []
    elec_kwh = []
    elec_gbp = []

    for entry in elec_data:
        date = entry["interval_start"][:10]
        kwh = round(entry["consumption"], 2)
        gbp = round((kwh * elec_rate_p) / 100, 2)
        elec_dates.append(date)
        elec_kwh.append(kwh)
        elec_gbp.append(gbp)

    # --- Process gas ---
    gas_dates = []
    gas_kwh = []
    gas_gbp = []

    for entry in gas_data:
        date = entry["interval_start"][:10]
        kwh = round(m3_to_kwh(entry["consumption"]), 2)
        gbp = round((kwh * gas_rate_p) / 100, 2)
        gas_dates.append(date)
        gas_kwh.append(kwh)
        gas_gbp.append(gbp)

    # --- Summary stats ---
    total_elec_kwh = sum(elec_kwh)
    total_elec_gbp = sum(elec_gbp)
    total_gas_kwh = sum(gas_kwh)
    total_gas_gbp = sum(gas_gbp)
    total_gbp = total_elec_gbp + total_gas_gbp

    generated_at = datetime.now().strftime("%d %B %Y, %H:%M")

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Home Energy Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body {{
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #F2EDE4;
      color: #2C2C2C;
      margin: 0;
      padding: 16px;
    }}
    h1 {{
      font-size: 1.4rem;
      margin-bottom: 4px;
    }}
    .subtitle {{
      color: #888;
      font-size: 0.85rem;
      margin-bottom: 24px;
    }}
    .cards {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }}
    .card {{
      background: white;
      border-radius: 12px;
      padding: 16px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    }}
    .card-label {{
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #888;
      margin-bottom: 6px;
    }}
    .card-value {{
      font-size: 1.6rem;
      font-weight: 600;
      color: #2C2C2C;
    }}
    .card-sub {{
      font-size: 0.8rem;
      color: #aaa;
      margin-top: 4px;
    }}
    .chart-card {{
      background: white;
      border-radius: 12px;
      padding: 16px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
      margin-bottom: 16px;
    }}
    .chart-title {{
      font-size: 0.85rem;
      font-weight: 600;
      margin-bottom: 12px;
      color: #2C2C2C;
    }}
    .rate-row {{
      display: flex;
      gap: 12px;
      margin-bottom: 24px;
    }}
    .rate-chip {{
      background: #6B6B3A;
      color: white;
      border-radius: 20px;
      padding: 6px 14px;
      font-size: 0.8rem;
    }}
  </style>
</head>
<body>

  <h1>Energy Dashboard</h1>
  <div class="subtitle">49 Gertrude Road · Last 30 days · Generated {generated_at}</div>

  <div class="rate-row">
    <div class="rate-chip">⚡ {elec_rate_p:.2f}p/kWh</div>
    <div class="rate-chip">🔥 {gas_rate_p:.2f}p/kWh</div>
  </div>

  <div class="cards">
    <div class="card">
      <div class="card-label">Total spend</div>
      <div class="card-value">£{total_gbp:.2f}</div>
      <div class="card-sub">last 30 days</div>
    </div>
    <div class="card">
      <div class="card-label">Electricity</div>
      <div class="card-value">£{total_elec_gbp:.2f}</div>
      <div class="card-sub">{total_elec_kwh:.1f} kWh</div>
    </div>
    <div class="card">
      <div class="card-label">Gas</div>
      <div class="card-value">£{total_gas_gbp:.2f}</div>
      <div class="card-sub">{total_gas_kwh:.1f} kWh</div>
    </div>
  </div>

  <div class="chart-card">
    <div class="chart-title">⚡ Electricity — daily kWh</div>
    <canvas id="elecKwh"></canvas>
  </div>

  <div class="chart-card">
    <div class="chart-title">⚡ Electricity — daily £</div>
    <canvas id="elecGbp"></canvas>
  </div>

  <div class="chart-card">
    <div class="chart-title">🔥 Gas — daily kWh</div>
    <canvas id="gasKwh"></canvas>
  </div>

  <div class="chart-card">
    <div class="chart-title">🔥 Gas — daily £</div>
    <canvas id="gasGbp"></canvas>
  </div>

  <script>
    const chartDefaults = {{
      responsive: true,
      plugins: {{ legend: {{ display: false }} }},
      scales: {{
        x: {{ ticks: {{ font: {{ size: 10 }}, maxRotation: 45 }} }},
        y: {{ ticks: {{ font: {{ size: 10 }} }} }}
      }}
    }};

    new Chart(document.getElementById('elecKwh'), {{
      type: 'bar',
      data: {{
        labels: {elec_dates},
        datasets: [{{ data: {elec_kwh}, backgroundColor: '#7B9E87' }}]
      }},
      options: chartDefaults
    }});

    new Chart(document.getElementById('elecGbp'), {{
      type: 'bar',
      data: {{
        labels: {elec_dates},
        datasets: [{{ data: {elec_gbp}, backgroundColor: '#7B9E87' }}]
      }},
      options: chartDefaults
    }});

    new Chart(document.getElementById('gasKwh'), {{
      type: 'bar',
      data: {{
        labels: {gas_dates},
        datasets: [{{ data: {gas_kwh}, backgroundColor: '#C17D5A' }}]
      }},
      options: chartDefaults
    }});

    new Chart(document.getElementById('gasGbp'), {{
      type: 'bar',
      data: {{
        labels: {gas_dates},
        datasets: [{{ data: {gas_gbp}, backgroundColor: '#C17D5A' }}]
      }},
      options: chartDefaults
    }});
  </script>

</body>
</html>"""

    with open("dashboard.html", "w") as f:
        f.write(html)

    print("dashboard.html generated successfully")


def main():
    print("Fetching unit rates...")
    elec_rate = get_unit_rate("electricity", ELEC_TARIFF)
    gas_rate = get_unit_rate("gas", GAS_TARIFF)

    if not elec_rate or not gas_rate:
        print("Could not fetch unit rates — check tariff codes")
        return

    print("\nFetching 30 days of consumption...")
    elec_data = get_consumption("electricity", MPAN, ELEC_SERIAL, days=30)
    gas_data = get_consumption("gas", MPRN, GAS_SERIAL, days=30)

    print(f"Electricity: {len(elec_data)} days returned")
    print(f"Gas: {len(gas_data)} days returned")

    generate_html(elec_data, gas_data, elec_rate, gas_rate)


if __name__ == "__main__":
    main()