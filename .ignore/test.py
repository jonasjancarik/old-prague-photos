import requests
from bs4 import BeautifulSoup

# URL and headers for the initial GET request
initial_url = "http://katalog.ahmp.cz/pragapublica/permalink?xid=7BAF2038B67611DF820F00166F1163D4&fcDb=&onlyDigi=&modeView=MOSAIC&searchAsPhrase=&patternTxt="

# Start a session to keep cookies
session = requests.Session()

# Send the initial GET request
response = session.get(initial_url)

# Parse the response with BeautifulSoup
soup = BeautifulSoup(response.text, "html.parser")

# Extract the values for "_sourcePage" and "__fp"
source_page_value = soup.find("input", {"name": "_sourcePage"})["value"]
fp_value = soup.find("input", {"name": "__fp"})["value"]

# URL and headers for the second POST request
second_url = f'http://katalog.ahmp.cz/pragapublica/ViewControlImpl.action;jsessionid={session.cookies.get("JSESSIONID")}?_eventName=myPageRows'

# Data payload for the second POST request
data = {
    "pageRows": 10000,  # it simply won't show more than 10000 results
    "_sourcePage": source_page_value,
    "__fp": fp_value,
}

# Send the second POST request with the session cookies and form data
post_response = session.post(second_url, data=data)

post_response.text
