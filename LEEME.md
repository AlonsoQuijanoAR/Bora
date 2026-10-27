# Bitácora del Auto — versión 1.1.0

App para el celular (PWA): combustible, consumo, services, novedades, gastos, cubiertas y hoja técnica.
Los datos se guardan **solo en el teléfono**. No hay servidor ni cuentas.

## Cómo actualizar desde la 1.0

1. En el repositorio de GitHub: **Add file → Upload files**.
2. Arrastrá **todos** los archivos de este zip juntos (ya no hay carpetas). GitHub reemplaza los que tienen el mismo nombre.
3. **Commit changes** y esperá uno o dos minutos.
4. Abrí la app con conexión. Aparece "Hay una versión nueva" → **Actualizar**.
   Si no aparece, cerrala del todo y volvé a abrirla.
5. En la app, el engranaje de arriba → la versión tiene que decir **1.1.0**.

Tus datos se conservan. Las cargas viejas que decían "YPF BV" o "Shell BV" se separan solas en marca + estación.

Si en el repositorio quedó una carpeta `icons` de la versión anterior, se puede borrar: ya no se usa.

## Cómo se calcula el consumo

De tanque lleno a tanque lleno: entre dos cargas llenas con odómetro, todos los litros cargados
(incluidas las cargas parciales del medio) son lo que consumió el auto en esos km.
Un tanque suelto puede variar; los promedios de varios tanques son los confiables. Los tramos con valores
imposibles (menos de 2 o más de 40 L/100 km) quedan marcados con "revisar" y no entran en los promedios.

## Plan de mantenimiento

Viene un plan de ejemplo para un diésel. Revisá los intervalos con el manual o tu mecánico.
Para que avise desde ya, en cada ítem cargá cuándo se hizo por última vez (fecha y/o km).
A partir de ahí, cada service que registres con ese ítem reinicia la cuenta.

## Instalación desde cero (otro celular)

Abrir la dirección de GitHub Pages en Chrome → menú ⋮ → **Agregar a la pantalla principal**.
Después, en el engranaje → **Restaurar desde una copia** con el último archivo .json.

## Importante sobre los datos

- Quedan ligados a esa dirección y a Chrome de ese teléfono. Si cambiás de celular o borrás los datos de Chrome,
  usá la **copia de seguridad** para recuperarlos.
- Hacé una copia cada tanto (la app avisa si pasan más de 30 días) y guardala en Drive o mandátela por WhatsApp.
