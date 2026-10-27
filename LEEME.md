# Bitácora del Auto — etapa 1

App para el celular (PWA) para registrar cargas de combustible, ver el consumo y exportar a Excel.
Los datos se guardan **solo en el teléfono**. No hay servidor ni cuentas.

## Qué incluye esta etapa

- Datos del auto (nombre, modelo, patente, tanque, km).
- Cargas: fecha (editable, para cargar historial viejo), odómetro, litros, común/premium, precio, total,
  tanque lleno, limpiainyectores, uso desde la carga anterior (ruta/mixto/urbano), estación y notas.
  Completás dos de litros / precio / total y el tercero se calcula.
- Inicio: consumo de los últimos 5 tanques, km actuales, gasto del mes, costo por km, últimos precios.
- Historial por mes, con el consumo de cada tramo. Tocás una carga para editarla o borrarla.
- Estadísticas: consumo por tanque, común vs premium, ruta/mixto/urbano, con y sin limpiainyectores,
  precio por litro y gasto mensual.
- Exportar a Excel (.xlsx) con hojas Cargas, Resumen y Auto.
- Copia de seguridad en un archivo .json, y restauración desde ese archivo.
- Funciona sin conexión una vez instalada.

## Cómo se calcula el consumo

De tanque lleno a tanque lleno: entre dos cargas llenas con odómetro, todos los litros cargados
(incluidas las cargas parciales del medio) son lo que consumió el auto en esos km.
Como "lleno" no es siempre exactamente igual, un tanque suelto puede variar; los promedios de varios
tanques son los confiables. Los tramos con valores imposibles (menos de 2 o más de 40 L/100 km)
quedan marcados con "revisar" y no entran en los promedios.

## Cómo ponerla en el celular (una sola vez, gratis)

La app tiene que estar publicada en una dirección https para que Android permita instalarla.
Los datos igual quedan en el teléfono: la página solo entrega los archivos de la app.

Con GitHub Pages:

1. Crear una cuenta en github.com (si no tenés).
2. Crear un repositorio nuevo, por ejemplo `bitacora`, público.
3. En el repositorio: **Add file → Upload files** y arrastrar **todo el contenido** de esta carpeta
   (index.html, app.js, core.js, styles.css, sw.js, manifest.webmanifest y la carpeta icons). Confirmar con **Commit changes**.
4. Ir a **Settings → Pages**. En "Branch" elegir `main` y la carpeta `/ (root)`, y guardar.
5. Al minuto queda en `https://TU-USUARIO.github.io/bitacora/`.
6. Abrir esa dirección en **Chrome** del celular → menú ⋮ → **Agregar a la pantalla principal** (o "Instalar app").

## Importante sobre los datos

- Los datos quedan ligados a esa dirección y a Chrome de ese teléfono. Si cambiás la dirección,
  de celular, o borrás los datos de Chrome, usá la **copia de seguridad** para recuperarlos.
- Hacé una copia cada tanto (la app te avisa si pasan más de 30 días) y guardala en Drive o mandátela por WhatsApp.

## Cómo actualizar a una versión nueva

Subir los archivos nuevos al mismo repositorio, reemplazando los anteriores. La próxima vez que abras la app
con conexión aparece "Hay una versión nueva" → **Actualizar**. Los datos no se tocan.
