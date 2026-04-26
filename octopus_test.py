import os
import requests
import json
from datetime import datetime, timedelta
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.getenv("OCTOPUS_API_KEY")
MPAN = os.getenv("MPAN")
MPRN = os.getenv("MPRN")
ELEC_SERIAL = "Z17N039347"
GAS_SERIAL = "E6S11202861760"

BASE_URL = "https://api.octopus.energy/v1"


def get_consumption(meter_type, reference, serial, days=10):
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
        print(f"Error: {response.status_code}")
        print(response.text)
        return []

    return response.json().get("results", [])


def main():
    print("=" * 50)
    print("Octopus Energy — Live Consumption")
    print("=" * 50)

    print("\n--- Electricity (last 10 days) ---")
    elec_data = get_consumption("electricity", MPAN, ELEC_SERIAL)
    if elec_data:
        for entry in elec_data:
            date = entry["interval_start"][:10]
            kwh = entry["consumption"]
            print(f"  {date}: {kwh:.2f} kWh")
    else:
        print("  No data returned")

    print("\n--- Gas (last 10 days) ---")
    gas_data = get_consumption("gas", MPRN, GAS_SERIAL)
    if gas_data:
        for entry in gas_data:
            date = entry["interval_start"][:10]
            m3 = entry["consumption"]
            # Gas is billed in m³ but charged in kWh — standard conversion
            kwh = m3 * 1.02264 * 39.2 / 3.6
            print(f"  {date}: {m3:.3f} m³ = {kwh:.2f} kWh")
    else:
        print("  No data returned")

    print("\nDone.")


if __name__ == "__main__":
    main()