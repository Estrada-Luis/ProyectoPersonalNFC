# CompraNFC

Lista de la compra compartida mediante una URL guardada en una pegatina NFC.

## Uso

1. Ejecuta `start.bat`.
2. Abre `http://localhost:3000/casa/demo` en el PC.
3. Desde un móvil conectado a la misma Wi-Fi usa `http://IP_DEL_PC:3000/casa/demo`.
4. Escribe esa URL en la pegatina NFC con NFC Tools.

## Catálogo

Al arrancar intenta sincronizar el catálogo desde MercaAPI. Si falla, conserva el catálogo local.

Los productos incluyen, cuando la fuente lo permite, el formato/tamaño: packs, litros, gramos, etc. Por ejemplo: `Pack de 6 · 1 L cada uno`, `1 L`, `500 g`.

MercaAPI es una fuente no oficial y puede cambiar.
