import type { Preview } from '@storybook/react-vite'

// Tailwind base + shadcn CSS variables. Without this, every story renders
// unstyled because Tailwind utility classes resolve to nothing.
import '../src/index.css'

const preview: Preview = {
  parameters: {
    layout: 'padded',
    backgrounds: {
      default: 'app-light',
      values: [
        { name: 'app-light', value: 'hsl(0 0% 100%)' },
        { name: 'app-dark', value: 'hsl(240 10% 3.9%)' },
      ],
    },
    controls: { expanded: true },
  },
}

export default preview
