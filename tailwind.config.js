// Configuración centralizada de Tailwind CSS
// Este archivo es cargado por todas las páginas HTML del proyecto.
// Para cambiar colores o tipografía, editar SOLO aquí.
tailwind.config = {
    theme: {
        extend: {
            colors: {
                terra: {
                    primary: '#D35400',
                    secondary: '#1A2530',
                    accent: '#27AE60',
                    bg: '#F8F9FA',
                    warm: '#FFF8F2',
                    cream: '#FFFDF9',
                }
            },
            fontFamily: {
                heading: ['Montserrat', 'sans-serif'],
                body: ['Inter', 'sans-serif'],
            }
        }
    }
}
