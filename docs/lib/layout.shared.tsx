import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: '@researchcomputer/agents-sdk',
      url: '/docs',
    },
    githubUrl: 'https://github.com/ResearchComputer/agents-sdk',
  };
}
