import os
import requests
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.getenv("OCTOPUS_API_KEY")
MPRN = os.getenv("MPRN")
GAS_SERIAL = "E6S11202861760"

BASE_URL = "https://api.octopus.energy/v1"

url = f"{BASE_URL}/gas-meter-points/{MPRN}/meters/{GAS_SERIAL}/meter-point-readings/"

response = requests.get(url, auth=(API_KEY, ""))
print(f"Status: {response.status_code}")
print(f"Response: {response.text}")