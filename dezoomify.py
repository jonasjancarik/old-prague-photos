import os
import requests
from bs4 import BeautifulSoup
from PIL import Image
from io import BytesIO

# Define the URL of the page containing the Zoomify image
page_url = "YOUR_PAGE_URL_HERE"

# Fetch the HTML content of the page
response = requests.get(page_url)
html_content = response.text

# Parse the HTML content
soup = BeautifulSoup(html_content, "html.parser")

# Extract the base URL and image properties from the JavaScript code in the HTML
scripts = soup.find_all("script")
zoomify_base_url = ""
image_width = 0
image_height = 0
tile_size = 256  # Default tile size for Zoomify

for script in scripts:
    if "zoomifyImgPath" in script.string:
        lines = script.string.split("\n")
        for line in lines:
            if "zoomifyImgPath" in line:
                zoomify_base_url = line.split("=")[1].strip().strip('"').strip(";")
            if "totalWidth" in line:
                image_width = int(line.split("=")[1].strip().strip(";"))
            if "totalHeight" in line:
                image_height = int(line.split("=")[1].strip().strip(";"))

# Ensure we have all necessary information
if not zoomify_base_url or not image_width or not image_height:
    raise ValueError("Failed to extract image properties from the HTML content")

# Create a directory to store the downloaded tiles
tiles_dir = "zoomify_tiles"
os.makedirs(tiles_dir, exist_ok=True)

# Calculate the number of tiles
num_tiles_x = (image_width + tile_size - 1) // tile_size
num_tiles_y = (image_height + tile_size - 1) // tile_size

# Download all tiles
for tile_y in range(num_tiles_y):
    for tile_x in range(num_tiles_x):
        tile_url = f"{zoomify_base_url}/TileGroup0/{0}-{tile_x}-{tile_y}.jpg"
        tile_path = os.path.join(tiles_dir, f"tile_{tile_x}_{tile_y}.jpg")

        # Download the tile
        tile_response = requests.get(tile_url)
        if tile_response.status_code == 200:
            with open(tile_path, "wb") as tile_file:
                tile_file.write(tile_response.content)
            print(f"Downloaded {tile_url}")
        else:
            print(f"Failed to download {tile_url}")

# Stitch the tiles together
final_image = Image.new("RGB", (image_width, image_height))

for tile_y in range(num_tiles_y):
    for tile_x in range(num_tiles_x):
        tile_path = os.path.join(tiles_dir, f"tile_{tile_x}_{tile_y}.jpg")
        if os.path.exists(tile_path):
            tile_image = Image.open(tile_path)
            final_image.paste(tile_image, (tile_x * tile_size, tile_y * tile_size))

# Save the final stitched image
final_image.save("final_image.jpg")
print("Final image saved as 'final_image.jpg'")
